import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../db";
import { createApp } from "../app";
import type { LlmStreamer } from "../llm";

const scripted: LlmStreamer = {
  async *stream() {
    yield { type: "start", partial: {} } as never;
    yield { type: "text_start", contentIndex: 0, partial: {} } as never;
    yield { type: "text_delta", contentIndex: 0, delta: "hello", partial: {} } as never;
    yield { type: "text_end", contentIndex: 0, partial: {} } as never;
    yield { type: "done", message: { stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } } as never;
  },
};

const toolCallUsage = { input: 8, output: 12, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

const toolCallScripted: LlmStreamer = {
  async *stream() {
    yield { type: "start", partial: { role: "assistant", content: [] } } as never;
    yield {
      type: "toolcall_start",
      contentIndex: 0,
      partial: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_xyz789", name: "get_weather", arguments: {} }],
      },
    } as never;
    yield {
      type: "toolcall_delta",
      contentIndex: 0,
      delta: '{"location":"',
      partial: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_xyz789", name: "get_weather", arguments: {} }],
      },
    } as never;
    yield {
      type: "toolcall_delta",
      contentIndex: 0,
      delta: 'Paris"}',
      partial: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_xyz789", name: "get_weather", arguments: {} }],
      },
    } as never;
    yield {
      type: "toolcall_end",
      contentIndex: 0,
      toolCall: { type: "toolCall", id: "call_xyz789", name: "get_weather", arguments: { location: "Paris" } },
      partial: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_xyz789", name: "get_weather", arguments: { location: "Paris" } }],
      },
    } as never;
    yield {
      type: "done",
      message: {
        role: "assistant",
        stopReason: "toolUse",
        usage: toolCallUsage,
        content: [{ type: "toolCall", id: "call_xyz789", name: "get_weather", arguments: { location: "Paris" } }],
      },
    } as never;
  },
};

const erroringScripted: LlmStreamer = {
  async *stream() {
    yield { type: "text_start", contentIndex: 0, partial: {} } as never;
    yield { type: "text_delta", contentIndex: 0, delta: "partial output", partial: {} } as never;
    throw new Error("upstream provider exploded");
  },
};

const zeroedUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

const streamCapture: { model: unknown; options: Record<string, unknown> | undefined } = {
  model: undefined,
  options: undefined,
};
function resetOptionsCapture(): void {
  streamCapture.model = undefined;
  streamCapture.options = undefined;
}
const signalRecordingScripted: LlmStreamer = {
  async *stream(model, _context, options) {
    streamCapture.model = model;
    streamCapture.options = options;
    yield { type: "start", partial: {} } as never;
    yield { type: "done", message: { stopReason: "stop", usage: zeroedUsage } } as never;
  },
};

describe("POST /api/stream", () => {
  it("rejects a missing token", async () => {
    const app = createApp(openDb(":memory:"), scripted);
    const res = await app.request("/api/stream", { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
  });

  it("streams proxy events as SSE data lines", async () => {
    const app = createApp(openDb(":memory:"), scripted);
    const res = await app.request("/api/stream", {
      method: "POST",
      headers: { authorization: "Bearer chamfer-local", "content-type": "application/json" },
      body: JSON.stringify({ model: {}, context: { messages: [] }, options: {} }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    const events = text
      .split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => JSON.parse(l.slice(6)));
    expect(events.some((e) => e.type === "text_delta" && e.delta === "hello")).toBe(true);
    expect(events.at(-1)?.type).toBe("done");
  });

  it("streams a tool-call event sequence with id/toolName mapped and reason toolUse", async () => {
    const app = createApp(openDb(":memory:"), toolCallScripted);
    const res = await app.request("/api/stream", {
      method: "POST",
      headers: { authorization: "Bearer chamfer-local", "content-type": "application/json" },
      body: JSON.stringify({ model: {}, context: { messages: [] }, options: {} }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    const events = text
      .split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => JSON.parse(l.slice(6)));

    const start = events.find((e) => e.type === "toolcall_start");
    expect(start).toEqual({ type: "toolcall_start", contentIndex: 0, id: "call_xyz789", toolName: "get_weather" });

    const deltas = events.filter((e) => e.type === "toolcall_delta");
    expect(deltas).toEqual([
      { type: "toolcall_delta", contentIndex: 0, delta: '{"location":"' },
      { type: "toolcall_delta", contentIndex: 0, delta: 'Paris"}' },
    ]);
    for (const d of deltas) expect(d.partial).toBeUndefined();

    const end = events.find((e) => e.type === "toolcall_end");
    expect(end).toEqual({ type: "toolcall_end", contentIndex: 0 });

    const done = events.at(-1);
    expect(done).toEqual({ type: "done", reason: "toolUse", usage: toolCallUsage });
  });

  it("surfaces a mid-stream throw as an in-band SSE error event and still completes the response", async () => {
    const app = createApp(openDb(":memory:"), erroringScripted);
    const res = await app.request("/api/stream", {
      method: "POST",
      headers: { authorization: "Bearer chamfer-local", "content-type": "application/json" },
      body: JSON.stringify({ model: {}, context: { messages: [] }, options: {} }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    const events = text
      .split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => JSON.parse(l.slice(6)));

    expect(events.some((e) => e.type === "text_delta" && e.delta === "partial output")).toBe(true);

    const last = events.at(-1);
    expect(last).toEqual({
      type: "error",
      reason: "error",
      errorMessage: expect.stringContaining("upstream provider exploded"),
      usage: zeroedUsage,
    });
  });

  it("forwards the request's abort signal into the streamer options", async () => {
    resetOptionsCapture();
    const app = createApp(openDb(":memory:"), signalRecordingScripted);
    const res = await app.request("/api/stream", {
      method: "POST",
      headers: { authorization: "Bearer chamfer-local", "content-type": "application/json" },
      body: JSON.stringify({ model: {}, context: { messages: [] }, options: {} }),
    });
    expect(res.status).toBe(200);
    await res.text();

    expect(streamCapture.options?.signal).toBeInstanceOf(AbortSignal);
  });

  it("passes the selected provider's key and custom base URL to pi-ai", async () => {
    resetOptionsCapture();
    const app = createApp(openDb(":memory:"), signalRecordingScripted);
    await app.request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        openaiApiKey: "sk-custom",
        openaiBaseUrl: "https://gateway.example/v1",
      }),
    });

    const res = await app.request("/api/stream", {
      method: "POST",
      headers: { authorization: "Bearer chamfer-local", "content-type": "application/json" },
      body: JSON.stringify({
        model: { provider: "openai", id: "gpt-5", baseUrl: "https://api.openai.com/v1" },
        context: { messages: [] },
        options: {},
      }),
    });
    await res.text();

    expect(streamCapture.model).toMatchObject({ baseUrl: "https://gateway.example/v1" });
    expect(streamCapture.options?.apiKey).toBe("sk-custom");
  });

  describe("environment fallback", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("resolves the API key from the environment when nothing is stored", async () => {
      vi.stubEnv("OPENAI_API_KEY", "sk-oai-from-env");
      resetOptionsCapture();
      const app = createApp(openDb(":memory:"), signalRecordingScripted);
      const res = await app.request("/api/stream", {
        method: "POST",
        headers: { authorization: "Bearer chamfer-local", "content-type": "application/json" },
        body: JSON.stringify({ model: { provider: "openai", id: "gpt-5" }, context: { messages: [] }, options: {} }),
      });
      await res.text();
      expect(streamCapture.options?.apiKey).toBe("sk-oai-from-env");
    });

    it("prefers a stored key over the environment key", async () => {
      vi.stubEnv("OPENAI_API_KEY", "sk-oai-from-env");
      resetOptionsCapture();
      const app = createApp(openDb(":memory:"), signalRecordingScripted);
      await app.request("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ openaiApiKey: "sk-oai-from-db" }),
      });
      const res = await app.request("/api/stream", {
        method: "POST",
        headers: { authorization: "Bearer chamfer-local", "content-type": "application/json" },
        body: JSON.stringify({ model: { provider: "openai", id: "gpt-5" }, context: { messages: [] }, options: {} }),
      });
      await res.text();
      expect(streamCapture.options?.apiKey).toBe("sk-oai-from-db");
    });
  });
});
