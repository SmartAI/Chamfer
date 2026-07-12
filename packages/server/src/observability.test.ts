import { describe, expect, it } from "vitest";
import { langfuseConfig, langfuseSessionId, observeLlm, usageAttributes } from "./observability";
import type { LlmStreamer, PiEvent } from "./llm";

const usage = {
  input: 8,
  output: 12,
  cacheRead: 3,
  cacheWrite: 1,
  totalTokens: 24,
  cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02, total: 0.33 },
};

async function collect(iterable: AsyncIterable<PiEvent>): Promise<PiEvent[]> {
  const events: PiEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe("langfuseConfig", () => {
  it("is undefined when either key is missing", () => {
    expect(langfuseConfig({})).toBeUndefined();
    expect(langfuseConfig({ LANGFUSE_PUBLIC_KEY: "pk" })).toBeUndefined();
    expect(langfuseConfig({ LANGFUSE_SECRET_KEY: "sk" })).toBeUndefined();
  });

  it("defaults the base URL to Langfuse Cloud", () => {
    expect(langfuseConfig({ LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "sk" })).toEqual({
      publicKey: "pk",
      secretKey: "sk",
      baseUrl: "https://cloud.langfuse.com",
    });
  });

  it("honors LANGFUSE_BASE_URL", () => {
    const env = {
      LANGFUSE_PUBLIC_KEY: "pk",
      LANGFUSE_SECRET_KEY: "sk",
      LANGFUSE_BASE_URL: "https://langfuse.internal.example",
    };
    expect(langfuseConfig(env)?.baseUrl).toBe("https://langfuse.internal.example");
  });
});

describe("observeLlm", () => {
  // No OTel provider is registered in tests, so startObservation produces
  // non-recording spans; these tests pin the wire behavior of the wrapper.
  it("passes all events through unchanged and in order", async () => {
    const scripted: LlmStreamer = {
      async *stream() {
        yield { type: "start", partial: {} } as never;
        yield { type: "text_delta", contentIndex: 0, delta: "hello", partial: {} } as never;
        yield { type: "done", message: { stopReason: "stop", content: [{ type: "text", text: "hello" }], usage } } as never;
      },
    };
    const events = await collect(observeLlm(scripted, "chat-response").stream({}, { messages: [] }, {}));
    expect(events.map((e) => e.type)).toEqual(["start", "text_delta", "done"]);
    expect(events[1]).toMatchObject({ delta: "hello" });
  });

  it("passes error events through and keeps their usage", async () => {
    const erroring: LlmStreamer = {
      async *stream() {
        yield { type: "error", error: { stopReason: "error", errorMessage: "boom", usage } } as never;
      },
    };
    const events = await collect(observeLlm(erroring, "chat-response").stream({}, { messages: [] }, {}));
    expect(events).toEqual([{ type: "error", error: { stopReason: "error", errorMessage: "boom", usage } }]);
  });

  it("propagates a mid-stream throw", async () => {
    const throwing: LlmStreamer = {
      async *stream() {
        yield { type: "start", partial: {} } as never;
        throw new Error("upstream exploded");
      },
    };
    await expect(collect(observeLlm(throwing, "chat-response").stream({}, {}, {}))).rejects.toThrow("upstream exploded");
  });

  it("forwards model, context, and options to the wrapped streamer", async () => {
    const seen: unknown[] = [];
    const recording: LlmStreamer = {
      async *stream(model, context, options) {
        seen.push(model, context, options);
        yield { type: "done", message: { stopReason: "stop", content: [], usage } } as never;
      },
    };
    const model = { id: "gpt-5", provider: "openai" };
    const context = { messages: [] };
    const options = { apiKey: "sk-secret" };
    await collect(observeLlm(recording, "chat-response").stream(model, context, options));
    expect(seen).toEqual([model, context, options]);
  });
});

describe("usage mapping", () => {
  it("maps pi-ai usage and cost to Langfuse usageDetails/costDetails", () => {
    expect(usageAttributes(usage)).toEqual({
      usageDetails: {
        input: 8,
        output: 12,
        cache_read_input_tokens: 3,
        cache_creation_input_tokens: 1,
        total: 24,
      },
      costDetails: {
        input: 0.1,
        output: 0.2,
        cache_read_input_tokens: 0.01,
        cache_creation_input_tokens: 0.02,
        total: 0.33,
      },
    });
    expect(usageAttributes({ ...usage, reasoning: 5 }).usageDetails?.reasoning).toBe(5);
  });

  it("tolerates events without usage so tracing can never fail a stream", () => {
    expect(usageAttributes(undefined)).toEqual({});
    expect(usageAttributes({ ...usage, cost: undefined } as never)).toEqual({
      usageDetails: expect.objectContaining({ input: 8, output: 12 }),
    });
  });

  it("records a done event that carries no usage without breaking the stream", async () => {
    const bareDone: LlmStreamer = {
      async *stream() {
        yield { type: "done", message: { stopReason: "stop", content: [{ type: "text", text: "hi" }] } } as never;
      },
    };
    const events = await collect(observeLlm(bareDone, "conversation-title").stream({}, {}, {}));
    expect(events.map((e) => e.type)).toEqual(["done"]);
  });
});

describe("langfuseSessionId", () => {
  it("accepts conversation IDs that satisfy Langfuse's session contract", () => {
    expect(langfuseSessionId("conversation-123")).toBe("conversation-123");
  });

  it("rejects empty, non-ASCII, and 200-character IDs", () => {
    expect(langfuseSessionId(123)).toBeUndefined();
    expect(langfuseSessionId("")).toBeUndefined();
    expect(langfuseSessionId("conversation-\u2603")).toBeUndefined();
    expect(langfuseSessionId("x".repeat(200))).toBeUndefined();
  });
});
