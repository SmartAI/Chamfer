import { describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { Api, AssistantMessage, AssistantMessageEvent, Context, Model } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { isRetryableFailure, retryDelayMs, withStreamRetry } from "./retryStream";

const MODEL = { id: "fake", api: "anthropic-messages" as Api, provider: "anthropic" } as Model<Api>;
const CONTEXT: Context = { systemPrompt: "s", messages: [], tools: [] };

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantMessage(overrides: Partial<AssistantMessage>): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "" }],
    api: MODEL.api,
    provider: MODEL.provider,
    model: MODEL.id,
    usage: ZERO_USAGE,
    stopReason: "stop",
    timestamp: 1,
    ...overrides,
  } as AssistantMessage;
}

function failingStream(errorMessage: string) {
  const stream = createAssistantMessageEventStream();
  const failed = assistantMessage({ stopReason: "error", errorMessage });
  queueMicrotask(() => {
    stream.push({ type: "start", partial: failed });
    stream.push({ type: "error", reason: "error", error: failed });
  });
  return stream;
}

function successStream(text: string) {
  const stream = createAssistantMessageEventStream();
  const final = assistantMessage({ content: [{ type: "text", text }] });
  queueMicrotask(() => {
    stream.push({ type: "start", partial: final });
    stream.push({ type: "text_start", contentIndex: 0, partial: final });
    stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: final });
    stream.push({ type: "text_end", contentIndex: 0, content: text, partial: final });
    stream.push({ type: "done", reason: "stop", message: final });
  });
  return stream;
}

async function collect(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const instantSleep = () => Promise.resolve();

describe("withStreamRetry", () => {
  it("retries a pre-content 429 and forwards only the successful attempt's events", async () => {
    let calls = 0;
    const base: StreamFn = () => {
      calls += 1;
      return calls === 1 ? failingStream("429 rate limit exceeded, retry-after: 1") : successStream("hello");
    };
    const waits: number[] = [];
    const wrapped = withStreamRetry(base, {
      sleep: instantSleep,
      onWait: (info) => waits.push(info.delayMs),
    });

    const events = await collect(await wrapped(MODEL, CONTEXT, {}));

    expect(calls).toBe(2);
    expect(waits).toEqual([1000]);
    expect(events.map((e) => e.type)).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);
    const done = events.at(-1);
    expect(done?.type).toBe("done");
  });

  it("gives up after maxAttempts and surfaces the original failure", async () => {
    let calls = 0;
    const base: StreamFn = () => {
      calls += 1;
      return failingStream("too many requests");
    };
    const wrapped = withStreamRetry(base, { maxAttempts: 3, sleep: instantSleep });

    const events = await collect(await wrapped(MODEL, CONTEXT, {}));

    expect(calls).toBe(3);
    const terminal = events.at(-1);
    expect(terminal?.type).toBe("error");
    if (terminal?.type === "error") expect(terminal.error.errorMessage).toContain("too many requests");
  });

  it("does not retry non-rate-limit failures", async () => {
    let calls = 0;
    const base: StreamFn = () => {
      calls += 1;
      return failingStream("401 unauthorized: invalid api key");
    };
    const wrapped = withStreamRetry(base, { sleep: instantSleep });

    const events = await collect(await wrapped(MODEL, CONTEXT, {}));

    expect(calls).toBe(1);
    expect(events.at(-1)?.type).toBe("error");
  });

  it("does not retry once content has streamed (mid-stream failure passes through)", async () => {
    let calls = 0;
    const base: StreamFn = () => {
      calls += 1;
      const stream = createAssistantMessageEventStream();
      const failed = assistantMessage({ stopReason: "error", errorMessage: "429 rate limited mid-flight" });
      queueMicrotask(() => {
        stream.push({ type: "start", partial: failed });
        stream.push({ type: "text_start", contentIndex: 0, partial: failed });
        stream.push({ type: "text_delta", contentIndex: 0, delta: "partial", partial: failed });
        stream.push({ type: "error", reason: "error", error: failed });
      });
      return stream;
    };
    const wrapped = withStreamRetry(base, { sleep: instantSleep });

    const events = await collect(await wrapped(MODEL, CONTEXT, {}));

    expect(calls).toBe(1);
    expect(events.map((e) => e.type)).toEqual(["start", "text_start", "text_delta", "error"]);
  });

  it("resolves result() with the final message of the successful attempt", async () => {
    let calls = 0;
    const base: StreamFn = () => {
      calls += 1;
      return calls === 1 ? failingStream("overloaded (529)") : successStream("done!");
    };
    const wrapped = withStreamRetry(base, { sleep: instantSleep });
    const stream = await wrapped(MODEL, CONTEXT, {});
    void collect(stream);

    const final = await stream.result();
    expect(final.stopReason).toBe("stop");
    expect(final.content).toEqual([{ type: "text", text: "done!" }]);
  });

  it("stops retrying when the caller aborts during the wait", async () => {
    let calls = 0;
    const controller = new AbortController();
    const base: StreamFn = () => {
      calls += 1;
      return failingStream("429 too many requests");
    };
    const wrapped = withStreamRetry(base, {
      sleep: () => {
        controller.abort();
        return Promise.resolve();
      },
    });

    const events = await collect(await wrapped(MODEL, CONTEXT, { signal: controller.signal }));

    expect(calls).toBe(1);
    expect(events.at(-1)?.type).toBe("error");
  });
});

describe("retry classification", () => {
  it("matches 429/529/rate-limit/overloaded and rejects the rest", () => {
    expect(isRetryableFailure("HTTP 429")).toBe(true);
    expect(isRetryableFailure("error 529: overloaded_error")).toBe(true);
    expect(isRetryableFailure("Rate limit reached")).toBe(true);
    expect(isRetryableFailure("401 unauthorized")).toBe(false);
    expect(isRetryableFailure(undefined)).toBe(false);
  });

  it("prefers the server retry-after hint and caps at maxDelayMs", () => {
    expect(retryDelayMs("429, retry-after: 12", 1, 2000, 60_000)).toBe(12_000);
    expect(retryDelayMs('{"retryAfter":90}', 1, 2000, 60_000)).toBe(60_000);
    const backoff = retryDelayMs("429", 3, 2000, 60_000);
    expect(backoff).toBeGreaterThanOrEqual(6400);
    expect(backoff).toBeLessThanOrEqual(9600);
  });
});
