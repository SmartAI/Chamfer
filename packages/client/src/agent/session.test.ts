import { describe, expect, it, vi, beforeEach } from "vitest";
import { createAssistantMessageEventStream, Type } from "@earendil-works/pi-ai";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import * as rest from "../api/rest";
import { classifySessionError, createSession, type SessionError, type SessionState } from "./session";
import { systemPrompt } from "./prompt";

vi.mock("../api/rest", () => ({
  postMessage: vi.fn(async (_conversationId: string, message: { id: string; seq: number; role: string; contentJson: string }) => ({
    id: message.id,
    conversationId: "conv-1",
    seq: message.seq,
    role: message.role,
    contentJson: message.contentJson,
    createdAt: Date.now(),
  })),
  uploadAttachment: vi.fn(async (messageId: string, kind: string, mime: string) => ({
    id: "attachment-1",
    messageId,
    kind,
    mime,
  })),
}));

const FAKE_MODEL: Model<Api> = {
  id: "fake-model",
  name: "Fake Model",
  api: "anthropic-messages" as Api,
  provider: "anthropic",
  baseUrl: "https://example.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 4096,
};

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** Fake streamFn: yields two text deltas then completes, matching the AssistantMessageEventStream contract. */
function makeFakeStreamFn() {
  return vi.fn(() => {
    const stream = createAssistantMessageEventStream();
    const base: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "" }],
      api: FAKE_MODEL.api,
      provider: FAKE_MODEL.provider,
      model: FAKE_MODEL.id,
      usage: ZERO_USAGE,
      stopReason: "stop",
      timestamp: Date.now(),
    };
    queueMicrotask(() => {
      stream.push({ type: "start", partial: base });
      stream.push({
        type: "text_start",
        contentIndex: 0,
        partial: base,
      });
      const partial1: AssistantMessage = { ...base, content: [{ type: "text", text: "Hello" }] };
      stream.push({ type: "text_delta", contentIndex: 0, delta: "Hello", partial: partial1 });
      const partial2: AssistantMessage = { ...base, content: [{ type: "text", text: "Hello world" }] };
      stream.push({ type: "text_delta", contentIndex: 0, delta: " world", partial: partial2 });
      const finalMessage: AssistantMessage = { ...base, content: [{ type: "text", text: "Hello world" }] };
      stream.push({ type: "text_end", contentIndex: 0, content: "Hello world", partial: finalMessage });
      stream.push({ type: "done", reason: "stop", message: finalMessage });
      stream.end(finalMessage);
    });
    return stream;
  });
}

describe("createSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("persists the user message then the completed assistant message in order, and streams a partial before completion", async () => {
    const streamFn = makeFakeStreamFn();
    const session = createSession({
      conversationId: "conv-1",
      modelJson: JSON.stringify(FAKE_MODEL),
      systemPrompt,
      priorMessages: [],
      __streamFn: streamFn,
    } as unknown as Parameters<typeof createSession>[0]);

    const states: { messages: unknown[]; streaming: boolean }[] = [];
    const unsubscribe = session.subscribe((state) => {
      states.push({ messages: state.messages.slice(), streaming: state.streaming });
    });

    await session.send("Hi there");

    unsubscribe();

    // rest.postMessage called at least twice: user message, then assistant message.
    const postMessage = rest.postMessage as unknown as ReturnType<typeof vi.fn>;
    expect(postMessage.mock.calls.length).toBeGreaterThanOrEqual(2);

    const [firstCall, secondCall] = postMessage.mock.calls;
    if (!firstCall || !secondCall) throw new Error("expected two postMessage calls");
    expect(firstCall[0]).toBe("conv-1");
    expect(firstCall[1].role).toBe("user");
    expect(firstCall[1].seq).toBe(0);
    const firstContent = JSON.parse(firstCall[1].contentJson);
    expect(firstContent.role).toBe("user");

    expect(secondCall[0]).toBe("conv-1");
    expect(secondCall[1].role).toBe("assistant");
    expect(secondCall[1].seq).toBe(1);
    const secondContent = JSON.parse(secondCall[1].contentJson);
    expect(secondContent.role).toBe("assistant");
    expect(secondContent.content[0].text).toBe("Hello world");

    // A streaming partial with streaming=true must have been observed before completion.
    const sawStreamingPartial = states.some(
      (s) => s.streaming === true && s.messages.some((m) => (m as { role?: string }).role === "assistant"),
    );
    expect(sawStreamingPartial).toBe(true);

    // Final state must not be streaming and must contain both messages.
    const finalState = states[states.length - 1];
    expect(finalState?.streaming).toBe(false);
    expect(finalState?.messages).toHaveLength(2);
  });

  it("replays prior messages into state on creation", () => {
    const streamFn = makeFakeStreamFn();
    const prior = [{ role: "user", content: "earlier", timestamp: 1 }];
    const session = createSession({
      conversationId: "conv-1",
      modelJson: JSON.stringify(FAKE_MODEL),
      systemPrompt,
      priorMessages: prior,
      __streamFn: streamFn,
    } as unknown as Parameters<typeof createSession>[0]);

    let latest: { messages: unknown[] } | undefined;
    session.subscribe((state) => {
      latest = state;
    })();

    expect(latest?.messages).toEqual(prior);
  });

  it("abort() does not reject or throw when no run is active", () => {
    const streamFn = makeFakeStreamFn();
    const session = createSession({
      conversationId: "conv-1",
      modelJson: JSON.stringify(FAKE_MODEL),
      systemPrompt,
      priorMessages: [],
      __streamFn: streamFn,
    } as unknown as Parameters<typeof createSession>[0]);

    expect(() => session.abort()).not.toThrow();
  });

  it("abort() during an active send does not cause an unhandled rejection", async () => {
    const streamFn = makeFakeStreamFn();
    const session = createSession({
      conversationId: "conv-1",
      modelJson: JSON.stringify(FAKE_MODEL),
      systemPrompt,
      priorMessages: [],
      __streamFn: streamFn,
    } as unknown as Parameters<typeof createSession>[0]);

    const sendPromise = session.send("Hi there");
    session.abort();

    await expect(sendPromise).resolves.toBeUndefined();
  });

  it("a user-initiated abort ends the turn without surfacing an error", async () => {
    // Stream that stays pending until the abort signal fires, then rejects with the
    // signal's reason — the same shape streamProxy produces when a fetch is aborted.
    const streamFn = vi.fn(
      (_model: unknown, _context: unknown, options?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          const fail = () => reject(options?.signal?.reason ?? new Error("aborted"));
          if (options?.signal?.aborted) fail();
          else options?.signal?.addEventListener("abort", fail);
        }),
    );
    const session = createSession({
      conversationId: "conv-1",
      modelJson: JSON.stringify(FAKE_MODEL),
      systemPrompt,
      priorMessages: [],
      __streamFn: streamFn as never,
    } as unknown as Parameters<typeof createSession>[0]);

    let latest: SessionState | undefined;
    session.subscribe((state) => (latest = state));

    const sendPromise = session.send("build something big");
    // Let send() reach the streaming stage so an active run exists to abort.
    await new Promise((resolve) => setTimeout(resolve, 0));
    session.abort();
    await sendPromise;

    expect(latest?.streaming).toBe(false);
    expect(latest?.error).toBeUndefined();
  });

  it("recovers from a transient postMessage failure: retries once, persists both messages in order with contiguous seq, and never persists a synthetic error message", async () => {
    const streamFn = makeFakeStreamFn();
    const postMessage = rest.postMessage as unknown as ReturnType<typeof vi.fn>;
    let callCount = 0;
    const succeededCalls: { seq: number; role: string }[] = [];
    postMessage.mockImplementation(
      async (_conversationId: string, message: { id: string; seq: number; role: string; contentJson: string }) => {
        callCount += 1;
        // Fail only the very first attempt (persisting the user message), then succeed for
        // every subsequent call, including that message's retry.
        if (callCount === 1) {
          throw new Error("network blip");
        }
        succeededCalls.push({ seq: message.seq, role: message.role });
        return {
          id: message.id,
          conversationId: "conv-1",
          seq: message.seq,
          role: message.role,
          contentJson: message.contentJson,
          createdAt: Date.now(),
        };
      },
    );

    const session = createSession({
      conversationId: "conv-1",
      modelJson: JSON.stringify(FAKE_MODEL),
      systemPrompt,
      priorMessages: [],
      __streamFn: streamFn,
    } as unknown as Parameters<typeof createSession>[0]);

    let latest: { error?: SessionError } | undefined;
    const unsubscribe = session.subscribe((state) => {
      latest = state;
    });

    await session.send("Hi there");

    unsubscribe();

    // First attempt (failed) + retry (succeeded) for the user message, plus one call for the
    // assistant message: three calls total, but only two distinct seq slots persisted.
    expect(postMessage.mock.calls.length).toBe(3);

    const bySeq = succeededCalls.slice().sort((a, b) => a.seq - b.seq);
    expect(bySeq.map((m) => m.seq)).toEqual([0, 1]);
    expect(bySeq.map((m) => m.role)).toEqual(["user", "assistant"]);

    // No synthetic error assistant message (empty text content, stopReason "error") was ever
    // sent to postMessage.
    for (const call of postMessage.mock.calls) {
      const content = JSON.parse(call[1].contentJson);
      expect(content.stopReason).not.toBe("error");
    }

    expect(latest?.error).toBeUndefined();
  });

  it("a permanently failing postMessage still lets the turn complete, records a persist error, and never persists a synthetic assistant message in its place", async () => {
    const streamFn = makeFakeStreamFn();
    const postMessage = rest.postMessage as unknown as ReturnType<typeof vi.fn>;
    postMessage.mockImplementation(async () => {
      throw new Error("db unreachable");
    });

    const session = createSession({
      conversationId: "conv-1",
      modelJson: JSON.stringify(FAKE_MODEL),
      systemPrompt,
      priorMessages: [],
      __streamFn: streamFn,
    } as unknown as Parameters<typeof createSession>[0]);

    let latest: { error?: SessionError } | undefined;
    const unsubscribe = session.subscribe((state) => {
      latest = state;
    });

    await expect(session.send("Hi there")).resolves.toBeUndefined();

    unsubscribe();

    expect(latest?.error).toBeDefined();
    expect(latest?.error?.kind).toBe("generic");
    expect(latest?.error?.message).toContain("persist");

    // Every attempted persist call carried the real user/assistant payload; no synthetic
    // error assistant message (produced by pi's handleRunFailure) was ever posted.
    for (const call of postMessage.mock.calls) {
      const content = JSON.parse(call[1].contentJson);
      expect(content.stopReason).not.toBe("error");
    }
  });

  /** Scripted streamFn requesting one more run_build123d call every turn, forever, until
   * the abort signal is set; then it finishes with an aborted message. Drives the
   * CAD-runs-per-turn cap tests. */
  function makeCadLoopHarness() {
    let toolCallCounter = 0;
    const streamFn = vi.fn((_model: unknown, _context: unknown, options?: { signal?: AbortSignal }) => {
      const stream = createAssistantMessageEventStream();
      toolCallCounter += 1;
      const aborted = options?.signal?.aborted === true;
      const message: AssistantMessage = {
        role: "assistant",
        content: aborted
          ? [{ type: "text", text: "" }]
          : [
              {
                type: "toolCall",
                id: `call-${toolCallCounter}`,
                name: "run_build123d",
                arguments: { code: "result = Box(1, 1, 1)" },
              },
            ],
        api: FAKE_MODEL.api,
        provider: FAKE_MODEL.provider,
        model: FAKE_MODEL.id,
        usage: ZERO_USAGE,
        stopReason: aborted ? "aborted" : "toolUse",
        errorMessage: aborted ? "aborted" : undefined,
        timestamp: Date.now(),
      };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        // The loop reads stopReason from the final message, not the done event,
        // and the done event's reason type does not admit "aborted".
        stream.push({ type: "done", reason: aborted ? "stop" : "toolUse", message });
        stream.end(message);
      });
      return stream;
    });

    const execute = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "ran" }],
      details: {},
    }));
    const tool = {
      name: "run_build123d",
      label: "Run build123d",
      description: "fake run tool",
      parameters: Type.Object({ code: Type.String() }),
      execute,
    };
    return { streamFn, execute, tool };
  }

  it("honors a configured maxCadRuns instead of the default cap", async () => {
    pinResolvingPostMessage();
    const { streamFn, execute, tool } = makeCadLoopHarness();

    const session = createSession({
      conversationId: "conv-1",
      modelJson: JSON.stringify(FAKE_MODEL),
      systemPrompt,
      tools: [tool],
      priorMessages: [],
      maxCadRuns: 2,
      __streamFn: streamFn,
    } as unknown as Parameters<typeof createSession>[0]);

    let latest: { messages: unknown[]; error?: SessionError } | undefined;
    const unsubscribe = session.subscribe((state) => {
      latest = state;
    });

    await session.send("build a box");

    expect(execute).toHaveBeenCalledTimes(2);
    expect(latest?.error?.message).toContain("Stopped after 2 CAD runs");

    unsubscribe();
  });

  it("caps run_build123d at 10 executions per turn, aborts the 11th, surfaces a notice, and resets the cap on the next send", async () => {
    pinResolvingPostMessage();
    const { streamFn, execute, tool } = makeCadLoopHarness();

    const session = createSession({
      conversationId: "conv-1",
      modelJson: JSON.stringify(FAKE_MODEL),
      systemPrompt,
      tools: [tool],
      priorMessages: [],
      __streamFn: streamFn,
    } as unknown as Parameters<typeof createSession>[0]);

    let latest: { messages: unknown[]; error?: SessionError } | undefined;
    const unsubscribe = session.subscribe((state) => {
      latest = state;
    });

    await session.send("build a box");

    // Exactly 10 tool executions ran; the 11th was aborted before execute().
    expect(execute).toHaveBeenCalledTimes(10);
    const erroredResults = (latest?.messages ?? []).filter((m) => {
      const message = m as { role?: string; isError?: boolean };
      return message.role === "toolResult" && message.isError === true;
    });
    expect(erroredResults).toHaveLength(1);
    expect(latest?.error?.kind).toBe("generic");
    expect(latest?.error?.message).toContain("Stopped after 10 CAD runs");

    // The cap resets per send(): the next turn gets 10 fresh executions before
    // hitting the cap again (a stale counter would abort immediately).
    await session.send("try again");

    expect(execute).toHaveBeenCalledTimes(20);
    expect(latest?.error?.message).toContain("Stopped after 10 CAD runs");

    unsubscribe();
  });

  it("guards overlapping send() calls: the second resolves without an unhandled rejection and sets state.error, while the first turn completes normally", async () => {
    const streamFn = makeFakeStreamFn();
    const session = createSession({
      conversationId: "conv-1",
      modelJson: JSON.stringify(FAKE_MODEL),
      systemPrompt,
      priorMessages: [],
      __streamFn: streamFn,
    } as unknown as Parameters<typeof createSession>[0]);

    let latest: { messages: unknown[]; error?: SessionError } | undefined;
    const unsubscribe = session.subscribe((state) => {
      latest = state;
    });

    const firstSend = session.send("first");
    const secondSend = session.send("second");

    await expect(secondSend).resolves.toBeUndefined();
    expect(latest?.error).toBeDefined();
    expect(latest?.error?.kind).toBe("generic");
    expect(latest?.error?.message).toContain("already processing");

    await expect(firstSend).resolves.toBeUndefined();

    unsubscribe();

    // The first turn completed normally: user + assistant messages persisted.
    const postMessage = rest.postMessage as unknown as ReturnType<typeof vi.fn>;
    expect(postMessage.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(latest?.messages).toHaveLength(2);
  });

  // vi.clearAllMocks() does not undo mockImplementation() set by earlier tests, so both
  // image tests pin postMessage/uploadAttachment to known implementations up front.
  function pinResolvingPostMessage(): void {
    const postMessage = rest.postMessage as unknown as ReturnType<typeof vi.fn>;
    postMessage.mockImplementation(
      async (_conversationId: string, message: { id: string; seq: number; role: string; contentJson: string }) => ({
        id: message.id,
        conversationId: "conv-1",
        seq: message.seq,
        role: message.role,
        contentJson: message.contentJson,
        createdAt: Date.now(),
      }),
    );
  }

  it("send with an image embeds one image block after the text block in the persisted user message and uploads one user-image attachment", async () => {
    pinResolvingPostMessage();
    const uploadAttachment = rest.uploadAttachment as unknown as ReturnType<typeof vi.fn>;
    uploadAttachment.mockImplementation(async (messageId: string, kind: string, mime: string) => ({
      id: "attachment-1",
      messageId,
      kind,
      mime,
    }));

    const streamFn = makeFakeStreamFn();
    const session = createSession({
      conversationId: "conv-1",
      modelJson: JSON.stringify(FAKE_MODEL),
      systemPrompt,
      priorMessages: [],
      __streamFn: streamFn,
    } as unknown as Parameters<typeof createSession>[0]);

    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const file = new File([bytes], "sketch.png", { type: "image/png" });

    await session.send("like this", [file]);

    const postMessage = rest.postMessage as unknown as ReturnType<typeof vi.fn>;
    const userCall = postMessage.mock.calls[0];
    if (!userCall) throw new Error("expected a persisted user message");
    expect(userCall[1].role).toBe("user");
    const content = JSON.parse(userCall[1].contentJson).content as { type: string; text?: string; data?: string; mimeType?: string }[];
    expect(content[0]).toEqual({ type: "text", text: "like this" });
    const imageBlocks = content.filter((block) => block.type === "image");
    expect(imageBlocks).toHaveLength(1);
    expect(imageBlocks[0]?.mimeType).toBe("image/png");
    expect(imageBlocks[0]?.data).toBe(btoa(String.fromCharCode(...bytes)));

    // Exactly one attachment upload, tied to the persisted user message id.
    expect(uploadAttachment).toHaveBeenCalledTimes(1);
    const attachmentCall = uploadAttachment.mock.calls[0];
    expect(attachmentCall?.[0]).toBe(userCall[1].id);
    expect(attachmentCall?.[1]).toBe("user-image");
    expect(attachmentCall?.[2]).toBe("image/png");
  });

  it("a failing attachment upload sets state.error but send still resolves", async () => {
    pinResolvingPostMessage();
    const uploadAttachment = rest.uploadAttachment as unknown as ReturnType<typeof vi.fn>;
    uploadAttachment.mockImplementation(async () => {
      throw new Error("disk full");
    });

    const streamFn = makeFakeStreamFn();
    const session = createSession({
      conversationId: "conv-1",
      modelJson: JSON.stringify(FAKE_MODEL),
      systemPrompt,
      priorMessages: [],
      __streamFn: streamFn,
    } as unknown as Parameters<typeof createSession>[0]);

    let latest: { messages: unknown[]; streaming: boolean; error?: SessionError } | undefined;
    const unsubscribe = session.subscribe((state) => {
      latest = state;
    });

    const file = new File([new Uint8Array([1, 2, 3])], "sketch.png", { type: "image/png" });
    await expect(session.send("like this", [file])).resolves.toBeUndefined();

    unsubscribe();

    expect(latest?.error?.kind).toBe("generic");
    expect(latest?.error?.message).toContain("attachment-persist-failed");
    expect(latest?.error?.message).toContain("disk full");
    // The turn itself still completed: both messages present, not streaming.
    expect(latest?.messages).toHaveLength(2);
    expect(latest?.streaming).toBe(false);
  });

  it("maps a 401 streamFn failure to an invalid-key error, and a follow-up send() still streams and clears it", async () => {
    pinResolvingPostMessage();
    // First turn: the streamFn fails like streamProxy does on an auth failure. Second
    // turn: a normal successful stream, proving the agent context survived the failure.
    const goodStreamFn = makeFakeStreamFn();
    let calls = 0;
    const streamFn = vi.fn((...args: Parameters<typeof goodStreamFn>) => {
      calls += 1;
      if (calls === 1) throw new Error("Proxy error: 401 invalid x-api-key");
      return goodStreamFn(...args);
    });

    const session = createSession({
      conversationId: "conv-1",
      modelJson: JSON.stringify(FAKE_MODEL),
      systemPrompt,
      priorMessages: [],
      __streamFn: streamFn,
    } as unknown as Parameters<typeof createSession>[0]);

    let latest: { messages: unknown[]; streaming: boolean; error?: SessionError } | undefined;
    const unsubscribe = session.subscribe((state) => {
      latest = state;
    });

    await expect(session.send("make a box")).resolves.toBeUndefined();

    expect(latest?.error?.kind).toBe("invalid-key");
    expect(latest?.error?.message).toContain("401");
    expect(latest?.streaming).toBe(false);

    // A follow-up send after the auth failure still works: the error clears on
    // agent_start and the turn streams to a completed assistant message.
    await expect(session.send("try again")).resolves.toBeUndefined();

    unsubscribe();

    expect(latest?.error).toBeUndefined();
    expect(latest?.streaming).toBe(false);
    const lastMessage = latest?.messages[latest.messages.length - 1] as
      | { role?: string; content?: { type: string; text?: string }[] }
      | undefined;
    expect(lastMessage?.role).toBe("assistant");
    expect(lastMessage?.content?.[0]?.text).toBe("Hello world");
  });

  it("maps a 429 streamFn failure to a rate-limited error", async () => {
    pinResolvingPostMessage();
    const streamFn = vi.fn(() => {
      throw new Error("429 rate limit exceeded, please retry shortly");
    });

    const session = createSession({
      conversationId: "conv-1",
      modelJson: JSON.stringify(FAKE_MODEL),
      systemPrompt,
      priorMessages: [],
      __streamFn: streamFn,
    } as unknown as Parameters<typeof createSession>[0]);

    let latest: { error?: SessionError } | undefined;
    const unsubscribe = session.subscribe((state) => {
      latest = state;
    });

    await expect(session.send("make a box")).resolves.toBeUndefined();

    unsubscribe();

    expect(latest?.error?.kind).toBe("rate-limited");
    expect(latest?.error?.message).toContain("429");
  });
});

describe("classifySessionError", () => {
  it("classifies auth/key/credit failure text as invalid-key", () => {
    expect(classifySessionError("Proxy error: 401 Unauthorized").kind).toBe("invalid-key");
    expect(classifySessionError("invalid x-api-key").kind).toBe("invalid-key");
    expect(classifySessionError("authentication_error: missing api key").kind).toBe("invalid-key");
    expect(classifySessionError("Your credit balance is too low").kind).toBe("invalid-key");
  });

  it("classifies 429/rate-limit failure text as rate-limited", () => {
    expect(classifySessionError("HTTP 429 Too Many Requests").kind).toBe("rate-limited");
    expect(classifySessionError("rate_limit_error: slow down").kind).toBe("rate-limited");
  });

  it("classifies everything else as generic, preserving the message", () => {
    const error = classifySessionError("Agent is already processing a prompt");
    expect(error).toEqual({ kind: "generic", message: "Agent is already processing a prompt" });
  });
});
