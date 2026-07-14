import { describe, expect, it, vi, beforeEach } from "vitest";
import { createAssistantMessageEventStream, Type } from "@earendil-works/pi-ai";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import * as rest from "../api/rest";
import {
  classifySessionError,
  createSession,
  buildPlanNudgePrompt,
  PLAN_NUDGE_MARKER,
  SELF_CHECK_MARKER,
  VISUAL_NUDGE_MARKER,
  normalizeInspectionEvidenceMessage,
  materializeAttachmentReferences,
  type SessionError,
  type SessionState,
} from "./session";
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
  postMessageWithAttachments: vi.fn(async (
    _conversationId: string,
    message: { id: string; seq: number; role: string; contentJson: string },
  ) => ({
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
  downloadAttachment: vi.fn(),
  classifyReference: vi.fn(),
  openInspectionLease: vi.fn(),
  recordInspectionObservation: vi.fn(),
  recordVisualVerification: vi.fn(),
  recordVisualVerificationBatch: vi.fn(),
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

it("never leaves native inspection pixels in durable content when lease details are malformed", () => {
  const malformed = {
    role: "toolResult",
    toolCallId: "inspect-malformed",
    toolName: "inspect_evidence",
    content: [{ type: "image", data: "must-not-persist", mimeType: "image/png" }],
    details: {},
    isError: false,
    timestamp: 1,
  };
  const durable = normalizeInspectionEvidenceMessage(malformed as never);
  expect(JSON.stringify(durable)).not.toContain("must-not-persist");
  expect(JSON.stringify(durable)).toContain("durable lease metadata was unavailable");
});

it("aborts an exact visual batch when any selected image cannot materialize", async () => {
  vi.mocked(rest.downloadAttachment)
    .mockResolvedValueOnce({ type: "image", data: "sheet", mimeType: "image/png" })
    .mockRejectedValueOnce(new Error("corrupt blob"));
  await expect(materializeAttachmentReferences([{
    role: "user",
    content: [
      { type: "text", text: "Compare this exact evidence set." },
      { type: "attachment-reference", attachmentId: "sheet-1", kind: "view-sheet", mimeType: "image/png" },
      { type: "attachment-reference", attachmentId: "ref-a", kind: "user-image", mimeType: "image/png" },
    ],
    timestamp: 1,
  } as never])).rejects.toThrow("Visual verification batch image unavailable: ref-a");
});

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

  it("consumes a user correction in the active pi run before the original send settles", async () => {
    const turnContexts: Array<{ messages: unknown[] }> = [];
    let finishFirstTurn: (() => void) | undefined;
    const streamFn = vi.fn((_model: unknown, context: { messages: unknown[] }) => {
      turnContexts.push(context);
      const stream = createAssistantMessageEventStream();
      const response: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: turnContexts.length === 1 ? "Working on the first request." : "Applied the correction." }],
        api: FAKE_MODEL.api,
        provider: FAKE_MODEL.provider,
        model: FAKE_MODEL.id,
        usage: ZERO_USAGE,
        stopReason: "stop",
        timestamp: Date.now(),
      };
      const finish = () => {
        stream.push({ type: "start", partial: response });
        stream.push({ type: "done", reason: "stop", message: response });
        stream.end(response);
      };
      if (turnContexts.length === 1) finishFirstTurn = finish;
      else queueMicrotask(finish);
      return stream;
    });
    const session = createSession({
      conversationId: "conv-1",
      modelJson: JSON.stringify(FAKE_MODEL),
      systemPrompt,
      priorMessages: [],
      __streamFn: streamFn,
    } as unknown as Parameters<typeof createSession>[0]);

    let originalSettled = false;
    const originalSend = session.send("Make a 10 mm wide box").then(() => {
      originalSettled = true;
    });
    await vi.waitUntil(() => finishFirstTurn !== undefined);

    const correction = session.steer("correction-1", "Change the width to 40 mm", []);
    expect(originalSettled).toBe(false);
    finishFirstTurn?.();
    await Promise.all([originalSend, correction]);

    expect(turnContexts).toHaveLength(2);
    expect(JSON.stringify(turnContexts[1]?.messages)).toContain("Change the width to 40 mm");
    const persistedUsers = vi.mocked(rest.postMessage).mock.calls
      .map((call) => JSON.parse(call[1].contentJson) as { role?: string; content?: unknown })
      .filter((message) => message.role === "user");
    expect(persistedUsers).toHaveLength(2);
    expect(JSON.stringify(persistedUsers[1])).toContain("Change the width to 40 mm");
  });

  it("consumes multiple corrections one at a time in send order", async () => {
    const turnContexts: Array<{ messages: unknown[] }> = [];
    let finishFirstTurn: (() => void) | undefined;
    const streamFn = vi.fn((_model: unknown, context: { messages: unknown[] }) => {
      turnContexts.push(context);
      const stream = createAssistantMessageEventStream();
      const response: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: `response ${turnContexts.length}` }],
        api: FAKE_MODEL.api,
        provider: FAKE_MODEL.provider,
        model: FAKE_MODEL.id,
        usage: ZERO_USAGE,
        stopReason: "stop",
        timestamp: Date.now(),
      };
      const finish = () => {
        stream.push({ type: "start", partial: response });
        stream.push({ type: "done", reason: "stop", message: response });
        stream.end(response);
      };
      if (turnContexts.length === 1) finishFirstTurn = finish;
      else queueMicrotask(finish);
      return stream;
    });
    const session = createSession({
      conversationId: "conv-1",
      modelJson: JSON.stringify(FAKE_MODEL),
      systemPrompt,
      priorMessages: [],
      __streamFn: streamFn,
    } as unknown as Parameters<typeof createSession>[0]);

    const original = session.send("Start");
    await vi.waitUntil(() => finishFirstTurn !== undefined);
    const first = session.steer("correction-1", "First correction", []);
    const second = session.steer("correction-2", "Second correction", []);
    finishFirstTurn?.();
    await Promise.all([original, first, second]);

    expect(turnContexts).toHaveLength(3);
    expect(JSON.stringify(turnContexts[1]?.messages)).toContain("First correction");
    expect(JSON.stringify(turnContexts[1]?.messages)).not.toContain("Second correction");
    expect(JSON.stringify(turnContexts[2]?.messages)).toContain("Second correction");
    const persistedUserText = vi.mocked(rest.postMessage).mock.calls
      .map((call) => JSON.stringify(JSON.parse(call[1].contentJson)))
      .filter((serialized) => serialized.includes('"role":"user"'));
    expect(persistedUserText).toEqual([
      expect.stringContaining("Start"),
      expect.stringContaining("First correction"),
      expect.stringContaining("Second correction"),
    ]);
  });

  it("keeps a delayed image correction ahead of a later text correction at the turn boundary", async () => {
    let releaseImage: (() => void) | undefined;
    const readSpy = vi.spyOn(FileReader.prototype, "readAsDataURL").mockImplementation(function (this: FileReader, file) {
      releaseImage = () => {
        Object.defineProperty(this, "result", { configurable: true, value: "data:image/png;base64,AQID" });
        this.onload?.(new ProgressEvent("load") as ProgressEvent<FileReader>);
      };
      void file;
    });
    try {
      const turnContexts: Array<{ messages: unknown[] }> = [];
      let finishFirstTurn: (() => void) | undefined;
      const streamFn = vi.fn((_model: unknown, context: { messages: unknown[] }) => {
        turnContexts.push(context);
        const stream = createAssistantMessageEventStream();
        const response: AssistantMessage = {
          role: "assistant",
          content: [{ type: "text", text: `response ${turnContexts.length}` }],
          api: FAKE_MODEL.api,
          provider: FAKE_MODEL.provider,
          model: FAKE_MODEL.id,
          usage: ZERO_USAGE,
          stopReason: "stop",
          timestamp: Date.now(),
        };
        const finish = () => {
          stream.push({ type: "start", partial: response });
          stream.push({ type: "done", reason: "stop", message: response });
          stream.end(response);
        };
        if (turnContexts.length === 1) finishFirstTurn = finish;
        else queueMicrotask(finish);
        return stream;
      });
      const session = createSession({
        conversationId: "conv-1",
        modelJson: JSON.stringify(FAKE_MODEL),
        systemPrompt,
        priorMessages: [],
        __streamFn: streamFn,
      } as unknown as Parameters<typeof createSession>[0]);
      const image = new File([new Uint8Array([1, 2, 3])], "slow.png", { type: "image/png" });

      const original = session.send("Start");
      await vi.waitUntil(() => finishFirstTurn !== undefined);
      const imageCorrection = session.steer("slow-image", "Use this image first", [image]);
      const textCorrection = session.steer("later-text", "Then make it wider", []);
      await vi.waitUntil(() => releaseImage !== undefined);
      finishFirstTurn?.();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(turnContexts).toHaveLength(1);
      releaseImage?.();
      await Promise.all([original, imageCorrection, textCorrection]);

      expect(turnContexts).toHaveLength(3);
      expect(JSON.stringify(turnContexts[1]?.messages.at(-1))).toContain("Use this image first");
      expect(JSON.stringify(turnContexts[2]?.messages.at(-1))).toContain("Then make it wider");
      const persistedUsers = [
        ...vi.mocked(rest.postMessage).mock.calls.map((call) => call[1]),
        ...vi.mocked(rest.postMessageWithAttachments).mock.calls.map((call) => call[1]),
      ]
        .filter((row) => row.role === "user")
        .sort((left, right) => left.seq - right.seq)
        .map((row) => row.contentJson);
      expect(persistedUsers).toEqual([
        expect.stringContaining("Start"),
        expect.stringContaining("Use this image first"),
        expect.stringContaining("Then make it wider"),
      ]);
    } finally {
      readSpy.mockRestore();
    }
  });

  it("activates each queued image reference only when pi consumes that steering message", async () => {
    const turnContexts: Array<{ messages: unknown[] }> = [];
    let finishFirstTurn: (() => void) | undefined;
    const streamFn = vi.fn((_model: unknown, context: { messages: unknown[] }) => {
      turnContexts.push(context);
      const stream = createAssistantMessageEventStream();
      const response: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: `response ${turnContexts.length}` }],
        api: FAKE_MODEL.api,
        provider: FAKE_MODEL.provider,
        model: FAKE_MODEL.id,
        usage: ZERO_USAGE,
        stopReason: "stop",
        timestamp: Date.now(),
      };
      const finish = () => {
        stream.push({ type: "start", partial: response });
        stream.push({ type: "done", reason: "stop", message: response });
        stream.end(response);
      };
      if (turnContexts.length === 1) finishFirstTurn = finish;
      else queueMicrotask(finish);
      return stream;
    });
    const session = createSession({
      conversationId: "conv-1",
      modelJson: JSON.stringify(FAKE_MODEL),
      systemPrompt,
      priorMessages: [],
      __streamFn: streamFn,
    } as unknown as Parameters<typeof createSession>[0]);
    const firstImage = new File([new Uint8Array([1])], "first.png", { type: "image/png" });
    const secondImage = new File([new Uint8Array([2])], "second.png", { type: "image/png" });
    const waitForRead = (file: File) => new Promise<void>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve();
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });

    const original = session.send("Start");
    await vi.waitUntil(() => finishFirstTurn !== undefined);
    const first = session.steer("image-1", "First image", [firstImage]);
    const second = session.steer("image-2", "Second image", [secondImage]);
    await Promise.all([waitForRead(firstImage), waitForRead(secondImage)]);
    await Promise.resolve();
    finishFirstTurn?.();
    await Promise.all([original, first, second]);

    const pendingIds = (context: { messages: unknown[] }) => {
      const ids = new Set<string>();
      for (const match of JSON.stringify(context.messages).matchAll(/Pending reference images: ([^.\]]+)/g)) {
        for (const id of (match[1] ?? "").split(",")) ids.add(id.trim());
      }
      return ids;
    };
    const secondRequestIds = pendingIds(turnContexts[1]!);
    const thirdRequestIds = pendingIds(turnContexts[2]!);
    expect(secondRequestIds.size).toBe(1);
    expect(thirdRequestIds.size).toBe(2);
    expect([...secondRequestIds].every((id) => thirdRequestIds.has(id))).toBe(true);
    expect(vi.mocked(rest.postMessageWithAttachments).mock.calls.map((call) => call[1].seq)).toEqual([2, 4]);
  });

  it("cancelling a prepared image correction leaves no reference gate in the next run", async () => {
    const turnContexts: Array<{ messages: unknown[] }> = [];
    let finishFirstTurn: (() => void) | undefined;
    const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "ran" }], details: {} }));
    const tool = {
      name: "run_build123d",
      label: "Run build123d",
      description: "fake run tool",
      parameters: Type.Object({ code: Type.String() }),
      execute,
    };
    const streamFn = vi.fn((_model: unknown, context: { messages: unknown[] }) => {
      turnContexts.push(context);
      const stream = createAssistantMessageEventStream();
      const response: AssistantMessage = turnContexts.length === 2
        ? {
            role: "assistant",
            content: [{ type: "toolCall", id: "clean-run", name: "run_build123d", arguments: { code: "result = Box(1, 1, 1)" } }],
            api: FAKE_MODEL.api,
            provider: FAKE_MODEL.provider,
            model: FAKE_MODEL.id,
            usage: ZERO_USAGE,
            stopReason: "toolUse",
            timestamp: Date.now(),
          }
        : {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
            api: FAKE_MODEL.api,
            provider: FAKE_MODEL.provider,
            model: FAKE_MODEL.id,
            usage: ZERO_USAGE,
            stopReason: "stop",
            timestamp: Date.now(),
          };
      const finish = () => {
        stream.push({ type: "start", partial: response });
        stream.push({ type: "done", reason: response.stopReason === "toolUse" ? "toolUse" : "stop", message: response });
        stream.end(response);
      };
      if (turnContexts.length === 1) finishFirstTurn = finish;
      else queueMicrotask(finish);
      return stream;
    });
    const session = createSession({
      conversationId: "conv-1",
      modelJson: JSON.stringify(FAKE_MODEL),
      systemPrompt,
      tools: [tool],
      priorMessages: [],
      __streamFn: streamFn,
    } as unknown as Parameters<typeof createSession>[0]);
    const image = new File([new Uint8Array([1, 2, 3])], "cancel.png", { type: "image/png" });

    const original = session.send("Start");
    await vi.waitUntil(() => finishFirstTurn !== undefined);
    const correction = session.steer("cancel-image", "Ignore this image", [image]);
    await new Promise<void>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve();
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(image);
    });
    await Promise.resolve();
    session.cancelSteering("cancel-image");
    await expect(correction).resolves.toBe("cancelled");
    finishFirstTurn?.();
    await original;

    await session.send("Start a clean run");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("preserves image content and atomic attachment persistence for a steered correction", async () => {
    const turnContexts: Array<{ messages: Array<{ content?: Array<{ type?: string; data?: string }> }> }> = [];
    let finishFirstTurn: (() => void) | undefined;
    const streamFn = vi.fn((_model: unknown, context: { messages: Array<{ content?: Array<{ type?: string; data?: string }> }> }) => {
      turnContexts.push(context);
      const stream = createAssistantMessageEventStream();
      const response: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        api: FAKE_MODEL.api,
        provider: FAKE_MODEL.provider,
        model: FAKE_MODEL.id,
        usage: ZERO_USAGE,
        stopReason: "stop",
        timestamp: Date.now(),
      };
      const finish = () => {
        stream.push({ type: "start", partial: response });
        stream.push({ type: "done", reason: "stop", message: response });
        stream.end(response);
      };
      if (turnContexts.length === 1) finishFirstTurn = finish;
      else queueMicrotask(finish);
      return stream;
    });
    const session = createSession({
      conversationId: "conv-1",
      modelJson: JSON.stringify(FAKE_MODEL),
      systemPrompt,
      priorMessages: [],
      __streamFn: streamFn as never,
    } as unknown as Parameters<typeof createSession>[0]);
    const image = new File([new Uint8Array([1, 2, 3])], "correction.png", { type: "image/png" });

    const original = session.send("Start");
    await vi.waitUntil(() => finishFirstTurn !== undefined);
    const correction = session.steer("image-correction", "Use this reference instead", [image]);
    await new Promise<void>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve();
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(image);
    });
    await Promise.resolve();
    finishFirstTurn?.();
    await Promise.all([original, correction]);

    const secondRequestImages = turnContexts[1]?.messages.flatMap((message) => message.content ?? [])
      .filter((block) => block.type === "image");
    expect(secondRequestImages).toEqual([expect.objectContaining({ type: "image", data: "AQID" })]);
    const atomicCalls = vi.mocked(rest.postMessageWithAttachments).mock.calls;
    expect(atomicCalls).toHaveLength(1);
    const durable = JSON.parse(atomicCalls[0]![1].contentJson);
    expect(durable.content.map((block: { type: string }) => block.type)).toEqual(["text", "attachment-reference"]);
    expect(atomicCalls[0]![2]).toEqual([expect.objectContaining({ kind: "user-image", data: "AQID" })]);
  });

  it("recovers after a mid-stream network error without persisting the interrupted assistant response", async () => {
    pinResolvingPostMessage();
    const successfulAttempt = makeFakeStreamFn() as StreamFn;
    let attempts = 0;
    const streamFn = vi.fn((...args: Parameters<StreamFn>) => {
      attempts += 1;
      if (attempts > 1) return successfulAttempt(...args);

      const stream = createAssistantMessageEventStream();
      const partial: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "I'll start by classifying the references." }],
        api: FAKE_MODEL.api,
        provider: FAKE_MODEL.provider,
        model: FAKE_MODEL.id,
        usage: ZERO_USAGE,
        stopReason: "stop",
        timestamp: Date.now(),
      };
      const failed: AssistantMessage = {
        ...partial,
        stopReason: "error",
        errorMessage: "network error",
      };
      queueMicrotask(() => {
        stream.push({ type: "start", partial });
        stream.push({ type: "text_start", contentIndex: 0, partial });
        stream.push({
          type: "text_delta",
          contentIndex: 0,
          delta: "I'll start by classifying the references.",
          partial,
        });
        stream.push({ type: "error", reason: "error", error: failed });
      });
      return stream;
    });
    const session = createSession({
      conversationId: "conv-1",
      modelJson: JSON.stringify(FAKE_MODEL),
      systemPrompt,
      priorMessages: [],
      __streamFn: streamFn,
      __retryOptions: { sleep: async () => undefined },
    } as unknown as Parameters<typeof createSession>[0]);

    let latest: SessionState | undefined;
    session.subscribe((state) => (latest = state));
    await session.send("Build from these references");

    expect(attempts).toBe(2);
    expect(latest?.error).toBeUndefined();
    expect(latest?.messages).toHaveLength(2);
    const postMessage = rest.postMessage as unknown as ReturnType<typeof vi.fn>;
    expect(postMessage).toHaveBeenCalledTimes(2);
    const persistedAssistant = JSON.parse(postMessage.mock.calls[1]?.[1].contentJson);
    expect(persistedAssistant.stopReason).toBe("stop");
    expect(persistedAssistant.content).toEqual([{ type: "text", text: "Hello world" }]);
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

  it("restores the error state of an interrupted persisted assistant response", () => {
    const prior = [
      { role: "user", content: "earlier", timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "text", text: "partial" }],
        stopReason: "error",
        errorMessage: "network error",
        timestamp: 2,
      },
    ];
    const session = createSession({
      conversationId: "conv-1",
      modelJson: JSON.stringify(FAKE_MODEL),
      systemPrompt,
      priorMessages: prior,
      __streamFn: makeFakeStreamFn(),
    } as unknown as Parameters<typeof createSession>[0]);

    let latest: SessionState | undefined;
    session.subscribe((state) => (latest = state))();

    expect(latest?.error).toEqual({ kind: "generic", message: "network error" });
    expect(latest?.streaming).toBe(false);
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

  it("abort cancels pending steering so it cannot leak into a later run", async () => {
    const laterStream = makeFakeStreamFn() as StreamFn;
    const turnContexts: Array<{ messages: unknown[] }> = [];
    let firstRunStarted = false;
    const streamFn = vi.fn(
      (_model: unknown, context: { messages: unknown[] }, options?: { signal?: AbortSignal }) => {
        turnContexts.push(context);
        if (turnContexts.length > 1) return laterStream(_model as never, context as never, options as never);
        firstRunStarted = true;
        return new Promise((_resolve, reject) => {
          const fail = () => reject(options?.signal?.reason ?? new Error("aborted"));
          if (options?.signal?.aborted) fail();
          else options?.signal?.addEventListener("abort", fail);
        });
      },
    );
    const session = createSession({
      conversationId: "conv-1",
      modelJson: JSON.stringify(FAKE_MODEL),
      systemPrompt,
      priorMessages: [],
      __streamFn: streamFn as never,
    } as unknown as Parameters<typeof createSession>[0]);

    const activeSend = session.send("Start the first run");
    await vi.waitUntil(() => firstRunStarted);
    const steering = session.steer("stopped-correction", "This correction belongs only to the stopped run", []);
    session.abort();
    await activeSend;

    expect(await Promise.race([steering, Promise.resolve("still-pending")])).toBe("cancelled");
    await session.send("Start a clean run");
    expect(JSON.stringify(turnContexts.at(-1)?.messages)).not.toContain("This correction belongs only to the stopped run");
  });

  it("provider termination cancels unconsumed steering so a later run cannot inherit it", async () => {
    const laterStream = makeFakeStreamFn() as StreamFn;
    const turnContexts: Array<{ messages: unknown[] }> = [];
    let rejectFirst: ((error: Error) => void) | undefined;
    const streamFn = vi.fn(
      (_model: unknown, context: { messages: unknown[] }, options?: { signal?: AbortSignal }) => {
        turnContexts.push(context);
        if (turnContexts.length > 1) return laterStream(_model as never, context as never, options as never);
        return new Promise((_resolve, reject) => {
          rejectFirst = reject;
        });
      },
    );
    const session = createSession({
      conversationId: "conv-1",
      modelJson: JSON.stringify(FAKE_MODEL),
      systemPrompt,
      priorMessages: [],
      __streamFn: streamFn as never,
    } as unknown as Parameters<typeof createSession>[0]);

    const failedSend = session.send("Start the failing run");
    await vi.waitUntil(() => rejectFirst !== undefined);
    const steering = session.steer("failed-correction", "Do not leak this correction", []);
    rejectFirst?.(new Error("invalid request shape"));

    await failedSend;
    await expect(steering).resolves.toBe("cancelled");
    await session.send("Start a clean run");
    expect(JSON.stringify(turnContexts.at(-1)?.messages)).not.toContain("Do not leak this correction");
  });

  it("gives user steering the next model turn before an autonomous self-check", async () => {
    const turnContexts: Array<{ messages: unknown[] }> = [];
    let resolveTool: (() => void) | undefined;
    const execute = vi.fn(
      () =>
        new Promise<{ content: [{ type: "text"; text: string }]; details: { gate: { status: "passed"; checks: [] } } }>((resolve) => {
          resolveTool = () => resolve({
            content: [{ type: "text", text: "ran" }],
            details: { gate: { status: "passed", checks: [] } },
          });
        }),
    );
    const tool = {
      name: "run_build123d",
      label: "Run build123d",
      description: "fake run tool",
      parameters: Type.Object({ code: Type.String() }),
      execute,
    };
    const streamFn = vi.fn((_model: unknown, context: { messages: unknown[] }) => {
      turnContexts.push(context);
      const stream = createAssistantMessageEventStream();
      const response: AssistantMessage = turnContexts.length === 1
        ? {
            role: "assistant",
            content: [{ type: "toolCall", id: "run-1", name: "run_build123d", arguments: { code: "result = Box(1, 1, 1)" } }],
            api: FAKE_MODEL.api,
            provider: FAKE_MODEL.provider,
            model: FAKE_MODEL.id,
            usage: ZERO_USAGE,
            stopReason: "toolUse",
            timestamp: Date.now(),
          }
        : {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
            api: FAKE_MODEL.api,
            provider: FAKE_MODEL.provider,
            model: FAKE_MODEL.id,
            usage: ZERO_USAGE,
            stopReason: "stop",
            timestamp: Date.now(),
          };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: response });
        stream.push({ type: "done", reason: response.stopReason === "toolUse" ? "toolUse" : "stop", message: response });
        stream.end(response);
      });
      return stream;
    });
    const session = createSession({
      conversationId: "conv-1",
      modelJson: JSON.stringify(FAKE_MODEL),
      systemPrompt,
      tools: [tool],
      priorMessages: [],
      __streamFn: streamFn,
    } as unknown as Parameters<typeof createSession>[0]);

    const original = session.send("Build a box");
    await vi.waitUntil(() => resolveTool !== undefined);
    const steering = session.steer("priority-correction", "Make the box 40 mm wide", []);
    resolveTool?.();
    await Promise.all([original, steering]);

    expect(turnContexts).toHaveLength(3);
    expect(JSON.stringify(turnContexts[1]?.messages.at(-1))).toContain("Make the box 40 mm wide");
    expect(JSON.stringify(turnContexts[1]?.messages)).not.toContain(SELF_CHECK_MARKER);
    expect(JSON.stringify(turnContexts[2]?.messages.at(-1))).toContain(SELF_CHECK_MARKER);
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
  // Image tests pin atomic persistence to known implementations up front.
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

  function pinResolvingAtomicPost(): void {
    const atomicPost = rest.postMessageWithAttachments as unknown as ReturnType<typeof vi.fn>;
    atomicPost.mockImplementation(async (
      _conversationId: string,
      message: { id: string; seq: number; role: string; contentJson: string },
    ) => ({ ...message, conversationId: "conv-1", createdAt: Date.now() }));
  }

  it("persists an ordered attachment reference without base64 while the live model request receives native pixels", async () => {
    pinResolvingPostMessage();
    pinResolvingAtomicPost();

    const streamFn = makeFakeStreamFn();
    const session = createSession({
      conversationId: "conv-1",
      modelJson: JSON.stringify(FAKE_MODEL),
      systemPrompt,
      priorMessages: [],
      __streamFn: streamFn,
    } as unknown as Parameters<typeof createSession>[0]);

    let latest: SessionState | undefined;
    session.subscribe((state) => (latest = state));

    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const file = new File([bytes], "sketch.png", { type: "image/png" });

    await session.send("like this", [file]);

    const atomicPost = rest.postMessageWithAttachments as unknown as ReturnType<typeof vi.fn>;
    expect(atomicPost).toHaveBeenCalledTimes(1);
    const atomicCall = atomicPost.mock.calls[0];
    expect(atomicCall?.[0]).toBe("conv-1");
    const persisted = JSON.parse(atomicCall?.[1].contentJson as string);
    const content = persisted.content as Array<Record<string, unknown>>;
    expect(content[0]).toEqual({ type: "text", text: "like this" });
    expect(content[1]).toMatchObject({
      type: "attachment-reference",
      kind: "user-image",
      mimeType: "image/png",
    });
    const attachmentId = content[1]?.attachmentId;
    expect(attachmentId).toEqual(expect.any(String));
    expect(atomicCall?.[1].contentJson).not.toContain('"data"');
    expect(atomicCall?.[1].contentJson).not.toContain(btoa(String.fromCharCode(...bytes)));

    const liveCalls = streamFn.mock.calls as unknown as Array<[unknown, { messages: Array<{ role: string; content: Array<Record<string, unknown>> }> }] >;
    const liveContext = liveCalls[0]?.[1];
    if (!liveContext) throw new Error("expected a live model context");
    expect(liveContext.messages[0]?.content).toEqual([
      { type: "text", text: "like this" },
      { type: "image", data: btoa(String.fromCharCode(...bytes)), mimeType: "image/png" },
      expect.objectContaining({ type: "text", text: expect.stringContaining("Pending reference images:") }),
    ]);
    const visibleUser = latest?.messages.find((message) => (message as { role?: string }).role === "user") as
      | { content?: Array<{ type?: string; text?: string }> }
      | undefined;
    expect(visibleUser?.content?.[0]).toEqual({ type: "text", text: "like this" });
    expect(visibleUser?.content?.some((block) => block.text?.includes("Pending reference images"))).toBe(false);

    expect(atomicCall?.[2]).toEqual([{
      id: attachmentId,
      kind: "user-image",
      mime: "image/png",
      data: btoa(String.fromCharCode(...bytes)),
    }]);
    const ordinaryPosts = rest.postMessage as unknown as ReturnType<typeof vi.fn>;
    expect(ordinaryPosts.mock.calls.some((call) => call[1].role === "user")).toBe(false);
  });

  it("a failing atomic attachment request keeps native pixels in memory and never posts a message row", async () => {
    pinResolvingPostMessage();
    const atomicPost = rest.postMessageWithAttachments as unknown as ReturnType<typeof vi.fn>;
    atomicPost.mockImplementation(async () => {
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
    const postMessage = rest.postMessage as unknown as ReturnType<typeof vi.fn>;
    expect(postMessage.mock.calls.some((call) => call[1].role === "user")).toBe(false);
    const liveUser = latest?.messages.find((message) => (message as { role?: string }).role === "user") as
      | { content?: Array<{ type?: string; data?: string }> }
      | undefined;
    expect(liveUser?.content?.[1]).toMatchObject({ type: "image", data: expect.any(String) });
    // The turn itself still completed: both messages present, not streaming.
    expect(latest?.messages).toHaveLength(2);
    expect(latest?.streaming).toBe(false);
  });

  it("retries the exact atomic request after a lost response", async () => {
    pinResolvingPostMessage();
    const atomicPost = rest.postMessageWithAttachments as unknown as ReturnType<typeof vi.fn>;
    atomicPost
      .mockRejectedValueOnce(new Error("response lost"))
      .mockImplementation(async (_conversationId: string, message: object) => message);
    const session = createSession({
      conversationId: "conv-1", modelJson: JSON.stringify(FAKE_MODEL), systemPrompt,
      priorMessages: [], __streamFn: makeFakeStreamFn(),
      __retryOptions: { sleep: async () => undefined },
    } as unknown as Parameters<typeof createSession>[0]);

    await session.send("retry image", [new File([new Uint8Array([1, 2, 3])], "retry.png", { type: "image/png" })]);

    expect(atomicPost).toHaveBeenCalledTimes(2);
    expect(atomicPost.mock.calls[0]).toEqual(atomicPost.mock.calls[1]);
  });

  it("materializes reloaded attachment references for model context without rewriting durable history", async () => {
    pinResolvingPostMessage();
    const downloadAttachment = rest.downloadAttachment as unknown as ReturnType<typeof vi.fn>;
    downloadAttachment.mockResolvedValue({ type: "image", data: "reloaded-pixels", mimeType: "image/png" });
    const prior = {
      role: "user",
      content: [
        { type: "text", text: "match this" },
        {
          type: "attachment-reference",
          attachmentId: "stored-image",
          kind: "user-image",
          mimeType: "image/png",
        },
      ],
      timestamp: 1,
    };
    const durableBefore = JSON.stringify(prior);
    const streamFn = makeFakeStreamFn();
    const session = createSession({
      conversationId: "conv-1",
      modelJson: JSON.stringify(FAKE_MODEL),
      systemPrompt,
      priorMessages: [prior],
      __streamFn: streamFn,
    } as unknown as Parameters<typeof createSession>[0]);

    await session.send("continue");

    const calls = streamFn.mock.calls as unknown as Array<[unknown, { messages: Array<{ content: Array<Record<string, unknown>> }> }] >;
    const context = calls[0]?.[1];
    if (!context) throw new Error("expected a materialized model context");
    expect(context.messages[0]?.content).toEqual([
      { type: "text", text: "match this" },
      { type: "image", data: "reloaded-pixels", mimeType: "image/png" },
      { type: "text", text: expect.stringContaining("Pending reference images: stored-image") },
    ]);
    expect(downloadAttachment).toHaveBeenCalledWith("stored-image", "image/png");
    expect(JSON.stringify(prior)).toBe(durableBefore);
  });

  it("replays the prior current sheet after a newer CAD execution fails without rendering", async () => {
    pinResolvingPostMessage();
    const downloadAttachment = rest.downloadAttachment as unknown as ReturnType<typeof vi.fn>;
    downloadAttachment.mockResolvedValue({ type: "image", data: "current-sheet", mimeType: "image/png" });
    const prior = [
      {
        role: "toolResult",
        toolCallId: "successful-run",
        toolName: "run_build123d",
        content: [
          { type: "text", text: "Measurements: volume 1" },
          { type: "attachment-reference", attachmentId: "current-sheet", kind: "view-sheet", mimeType: "image/png" },
        ],
        isError: false,
        timestamp: 1,
      },
      {
        role: "toolResult",
        toolCallId: "failed-run",
        toolName: "run_build123d",
        content: [{ type: "text", text: "Traceback" }],
        isError: true,
        timestamp: 2,
      },
    ];
    const streamFn = makeFakeStreamFn();
    const session = createSession({
      conversationId: "conv-1",
      modelJson: JSON.stringify(FAKE_MODEL),
      systemPrompt,
      priorMessages: prior,
      __streamFn: streamFn,
    } as unknown as Parameters<typeof createSession>[0]);

    await session.send("repair it");

    expect(downloadAttachment).toHaveBeenCalledWith("current-sheet", "image/png");
    const calls = streamFn.mock.calls as unknown as Array<[
      unknown,
      { messages: Array<{ content?: Array<{ type?: string }> }> },
    ]>;
    const context = calls[0]![1].messages;
    expect(context.flatMap((message) => message.content ?? []).filter((block) => block.type === "image")).toHaveLength(1);
  });

  it("does not replay finalized current-sheet pixels on a later user request", async () => {
    pinResolvingPostMessage();
    const downloadAttachment = rest.downloadAttachment as unknown as ReturnType<typeof vi.fn>;
    const prior = [
      {
        role: "toolResult",
        toolCallId: "successful-run",
        toolName: "run_build123d",
        content: [
          { type: "text", text: "Measurements: volume 1" },
          { type: "attachment-reference", attachmentId: "final-sheet", kind: "view-sheet", mimeType: "image/png" },
        ],
        isError: false,
        timestamp: 1,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Finished" }],
        stopReason: "stop",
        timestamp: 2,
      },
    ];
    const streamFn = makeFakeStreamFn();
    const session = createSession({
      conversationId: "conv-1",
      modelJson: JSON.stringify(FAKE_MODEL),
      systemPrompt,
      priorMessages: prior,
      __streamFn: streamFn,
    } as unknown as Parameters<typeof createSession>[0]);

    await session.send("start something new");

    expect(downloadAttachment).not.toHaveBeenCalledWith("final-sheet", "image/png");
    const calls = streamFn.mock.calls as unknown as Array<[
      unknown,
      { messages: Array<{ content?: Array<{ type?: string }> }> },
    ]>;
    const context = calls[0]![1].messages;
    expect(context.flatMap((message) => message.content ?? []).filter((block) => block.type === "image")).toHaveLength(0);
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

describe("createSession agent-loop policies", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function textMessage(text: string, stopReason: "stop" | "toolUse" = "stop"): AssistantMessage {
    return {
      role: "assistant",
      content: [{ type: "text", text }],
      api: FAKE_MODEL.api,
      provider: FAKE_MODEL.provider,
      model: FAKE_MODEL.id,
      usage: ZERO_USAGE,
      stopReason,
      timestamp: Date.now(),
    };
  }

  function toolCallMessage(id: string): AssistantMessage {
    return {
      ...textMessage("", "toolUse"),
      content: [{ type: "toolCall", id, name: "run_build123d", arguments: { code: "result = Box(1, 1, 1)" } }],
    };
  }

  function pushCompleted(message: AssistantMessage) {
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
      stream.end(message);
    });
    return stream;
  }

  /** streamFn that answers summarization requests from a canned summary and plays the
   * scripted assistant messages for everything else, recording each turn's context. */
  function makeScriptedStreamFn(script: AssistantMessage[], summaryText = "canned summary") {
    const turnContexts: { systemPrompt?: string; messages: unknown[] }[] = [];
    const summaryContexts: { systemPrompt?: string; messages: unknown[] }[] = [];
    const streamFn = vi.fn((_model: unknown, context: { systemPrompt?: string; messages: unknown[] }) => {
      if (context.systemPrompt?.includes("context summarization assistant")) {
        summaryContexts.push(context);
        return pushCompleted(textMessage(summaryText));
      }
      turnContexts.push(context);
      const next = script.shift();
      return pushCompleted(next ?? textMessage("script exhausted"));
    });
    return { streamFn, turnContexts, summaryContexts };
  }

  function gateTool(status: "passed" | "failed") {
    const execute = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "ran" }],
      details: { gate: { status, checks: [] } },
    }));
    return {
      tool: {
        name: "run_build123d",
        label: "Run build123d",
        description: "fake run tool",
        parameters: Type.Object({ code: Type.String() }),
        execute,
      },
      execute,
    };
  }

  it("blocks terminal completion when a newer failed artifact invalidates an older visual approval", async () => {
    const olderRun = {
      role: "toolResult",
      toolCallId: "older-run",
      toolName: "run_build123d",
      content: [{ type: "text", text: "passed" }],
      details: {
        code: { artifactId: "artifact-1", artifactVersion: 1 },
        inspectionSheet: {
          attachmentId: "sheet-1",
          code: { artifactId: "artifact-1", artifactVersion: 1 },
          gate: { status: "passed" },
        },
      },
      isError: false,
      timestamp: 1,
    };
    const failedNewerRun = {
      role: "toolResult",
      toolCallId: "newer-run",
      toolName: "run_build123d",
      content: [{ type: "text", text: "failed" }],
      details: {
        code: { artifactId: "artifact-2", artifactVersion: 2 },
        gate: { status: "failed" },
      },
      isError: true,
      timestamp: 3,
    };
    const olderApproval = {
      id: "verification-1",
      conversationId: "conv-1",
      artifactId: "artifact-1",
      artifactVersion: 1,
      inspectionSheetId: "sheet-1",
      coveredReferenceIds: ["ref-a"],
      verdict: "match" as const,
      observations: [{ referenceId: "ref-a", relevantViews: ["front"], findings: ["Matches."], affectedComponents: [] }],
      recordedAt: 2,
    };
    const { streamFn, turnContexts } = makeScriptedStreamFn([
      textMessage("The older approval should still count."),
      textMessage("Stopping after the visual check."),
    ]);
    const session = createSession({
      conversationId: "conv-1",
      modelJson: JSON.stringify(FAKE_MODEL),
      systemPrompt,
      priorMessages: [olderRun, failedNewerRun],
      referenceRecords: [{
        referenceId: "ref-a",
        conversationId: "conv-1",
        attachmentAvailable: true,
        status: "active",
        purpose: "Primary profile",
        relationships: [],
        specificationLinks: ["visual.profile"],
        history: [],
      }],
      visualVerifications: [olderApproval],
      __streamFn: streamFn as never,
    } as unknown as Parameters<typeof createSession>[0]);

    let latest: SessionState | undefined;
    session.subscribe((state) => (latest = state));
    await session.send("Finish the current revision");

    expect(turnContexts).toHaveLength(2);
    expect(countMarker(latest, VISUAL_NUDGE_MARKER)).toBe(1);
    expect(latest?.error?.message).toContain("visual finalization check");
  });

  it("exposes exactly the current sheet and sole active reference before one-reference finalization", async () => {
    vi.mocked(rest.downloadAttachment).mockImplementation(async (attachmentId) => ({
      type: "image",
      data: attachmentId === "sheet-1" ? "sheet-pixels" : "reference-pixels",
      mimeType: "image/png",
    }));
    const { streamFn, turnContexts } = makeScriptedStreamFn([
      textMessage("Attempting to finish without looking at the active reference."),
      textMessage("Stopping after the projected comparison request."),
    ]);
    const session = createSession({
      conversationId: "conv-1",
      modelJson: JSON.stringify({ ...FAKE_MODEL, input: ["text", "image"], maxInputImages: 4 }),
      systemPrompt,
      priorMessages: [
        {
          role: "user",
          content: [{ type: "attachment-reference", attachmentId: "ref-a", kind: "user-image", mimeType: "image/png" }],
          timestamp: 1,
        },
        {
          role: "toolResult",
          toolCallId: "run-1",
          toolName: "run_build123d",
          content: [{ type: "attachment-reference", attachmentId: "sheet-1", kind: "view-sheet", mimeType: "image/png" }],
          details: {
            code: { artifactId: "artifact-1", artifactVersion: 1 },
            inspectionSheet: {
              attachmentId: "sheet-1",
              code: { artifactId: "artifact-1", artifactVersion: 1 },
              gate: { status: "passed" },
            },
          },
          isError: false,
          timestamp: 2,
        },
      ],
      referenceRecords: [{
        referenceId: "ref-a",
        conversationId: "conv-1",
        attachmentAvailable: true,
        status: "active",
        purpose: "Primary profile",
        relationships: [],
        specificationLinks: ["visual.profile"],
        history: [],
      }],
      __streamFn: streamFn as never,
    } as unknown as Parameters<typeof createSession>[0]);

    await session.send("Finish the current artifact");

    expect(turnContexts).toHaveLength(2);
    const second = JSON.stringify(turnContexts[1]?.messages);
    expect(second).toContain("Visual verification batch 1/1");
    expect(second.match(/\"type\":\"image\"/g)).toHaveLength(2);
    expect(second).toContain("sheet-pixels");
    expect(second).toContain("reference-pixels");
  });

  it("retrieves historical evidence through a durable lease and evicts pixels only after observation", async () => {
    const lease = {
      id: "lease-1",
      conversationId: "conv-1",
      purpose: "Compare the earlier front profile",
      status: "open" as const,
      evidence: [{ attachmentId: "ref-a", kind: "user-image" as const, mime: "image/png" }],
      openedAt: 10,
    };
    vi.mocked(rest.openInspectionLease).mockResolvedValue(lease);
    vi.mocked(rest.recordInspectionObservation).mockResolvedValue({
      ...lease,
      status: "closed",
      closedAt: 20,
      observation: {
        id: "observation-1",
        leaseId: "lease-1",
        relevantViews: ["front"],
        facts: ["The flange extends beyond the body."],
        affectedSpecifications: ["spec.mount-width"],
        affectedComponents: ["mount"],
        recordedAt: 20,
      },
    });
    vi.mocked(rest.downloadAttachment).mockResolvedValue({ type: "image", data: "leased-pixels", mimeType: "image/png" });
    const inspectCall: AssistantMessage = {
      ...textMessage("", "toolUse"),
      content: [{
        type: "toolCall",
        id: "inspect-1",
        name: "inspect_evidence",
        arguments: { evidenceIds: ["ref-a"], purpose: lease.purpose },
      }],
    };
    const observationCall: AssistantMessage = {
      ...textMessage("", "toolUse"),
      content: [{
        type: "toolCall",
        id: "observe-1",
        name: "record_inspection_observation",
        arguments: {
          leaseId: "lease-1",
          relevantViews: ["front"],
          facts: ["The flange extends beyond the body."],
          affectedSpecifications: ["spec.mount-width"],
          affectedComponents: ["mount"],
        },
      }],
    };
    const { streamFn, turnContexts } = makeScriptedStreamFn([
      inspectCall,
      observationCall,
      textMessage("Inspection complete."),
    ]);
    const session = createSession({
      conversationId: "conv-1",
      modelJson: JSON.stringify(FAKE_MODEL),
      systemPrompt,
      priorMessages: [{
        role: "user",
        content: [
          { type: "text", text: "Earlier reference" },
          { type: "attachment-reference", attachmentId: "ref-a", kind: "user-image", mimeType: "image/png" },
        ],
        timestamp: 1,
      }],
      referenceRecords: [{
        referenceId: "ref-a",
        conversationId: "conv-1",
        attachmentAvailable: true,
        status: "active",
        purpose: "Primary profile",
        relationships: [],
        specificationLinks: ["spec.mount-width"],
        history: [],
      }],
      __streamFn: streamFn as never,
    } as unknown as Parameters<typeof createSession>[0]);

    await session.send("Inspect the earlier profile again");

    const imageCounts = turnContexts.map((context) => JSON.stringify(context.messages).match(/"type":"image"/g)?.length ?? 0);
    expect(imageCounts).toEqual([0, 1, 0, 0]);
    expect(JSON.stringify(turnContexts[1]?.messages)).toContain("Open inspection lease lease-1");
    expect(JSON.stringify(turnContexts[2]?.messages)).toContain("Inspection observation recorded");
    const persistedInspection = vi.mocked(rest.postMessage).mock.calls
      .map((call) => call[1].contentJson)
      .find((json) => json.includes('"toolName":"inspect_evidence"'));
    expect(persistedInspection).toContain('"attachmentId":"ref-a"');
    expect(persistedInspection).not.toContain("leased-pixels");
  });

  it("blocks unrelated tools until every open inspection lease records observations", async () => {
    const lease = {
      id: "lease-open",
      conversationId: "conv-1",
      purpose: "Inspect the earlier profile",
      status: "open" as const,
      evidence: [{ attachmentId: "ref-old", kind: "user-image" as const, mime: "image/png" }],
      openedAt: 10,
    };
    const unrelatedExecute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "should not run" }] }));
    vi.mocked(rest.recordInspectionObservation).mockResolvedValue({
      ...lease,
      status: "closed",
      closedAt: 20,
      observation: {
        id: "observation-open",
        leaseId: lease.id,
        relevantViews: ["front"],
        facts: ["The earlier profile is narrower."],
        affectedSpecifications: [],
        affectedComponents: ["body"],
        recordedAt: 20,
      },
    });
    vi.mocked(rest.downloadAttachment).mockResolvedValue({ type: "image", data: "leased-pixels", mimeType: "image/png" });
    const unrelatedCall: AssistantMessage = {
      ...textMessage("", "toolUse"),
      content: [{ type: "toolCall", id: "unrelated-1", name: "unrelated_action", arguments: {} }],
    };
    const observationCall: AssistantMessage = {
      ...textMessage("", "toolUse"),
      content: [{
        type: "toolCall",
        id: "observe-open",
        name: "record_inspection_observation",
        arguments: {
          leaseId: lease.id,
          relevantViews: ["front"],
          facts: ["The earlier profile is narrower."],
          affectedSpecifications: [],
          affectedComponents: ["body"],
        },
      }],
    };
    const { streamFn, turnContexts } = makeScriptedStreamFn([
      unrelatedCall,
      observationCall,
      textMessage("Observation recorded before continuing."),
    ]);
    const session = createSession({
      conversationId: "conv-1",
      modelJson: JSON.stringify(FAKE_MODEL),
      systemPrompt,
      priorMessages: [],
      openInspectionLeases: [lease],
      tools: [{
        name: "unrelated_action",
        label: "Unrelated action",
        description: "Must be blocked while evidence is leased.",
        parameters: Type.Object({}),
        execute: unrelatedExecute,
      }],
      __streamFn: streamFn as never,
    } as unknown as Parameters<typeof createSession>[0]);

    await session.send("Continue");

    expect(unrelatedExecute).not.toHaveBeenCalled();
    expect(JSON.stringify(turnContexts[1]?.messages)).toContain("blocked while inspection lease");
    expect(rest.recordInspectionObservation).toHaveBeenCalledWith("conv-1", lease.id, expect.any(Object), "observe-open");
  });

  it("blocks run_build123d for an image turn until update_plan accepts a spec-sheet plan", async () => {
    const { tool, execute } = gateTool("failed");
    const plan = {
      goal: "single image-derived spacer",
      components: [
        {
          id: "spacer",
          description: "10 mm cube spacer shown in the image",
          bbox_mm: [10, 10, 10],
          status: "todo",
          free_floating_reason: "single component",
          checks: [{ id: "volume", kind: "volume", range_mm3: [900, 1100], target: "spacer" }],
        },
      ],
      interfaces: [],
      spec_sheet: [
        {
          id: "cube-size",
          text: "The image shows a 10 mm cube.",
          source: "image",
          check_refs: [{ component_id: "spacer", check_id: "volume" }],
        },
      ],
    };
    const updatePlanCall: AssistantMessage = {
      ...textMessage("", "toolUse"),
      content: [{ type: "toolCall", id: "plan-1", name: "update_plan", arguments: plan }],
    };
    const classificationCall: AssistantMessage = {
      ...textMessage("", "toolUse"),
      content: [{
        type: "toolCall",
        id: "classify-plan-image",
        name: "classify_reference",
        arguments: {
          referenceId: "ref-plan",
          status: "active",
          purpose: "Dimensioned spacer drawing",
          relationships: [],
          rationale: "Defines the requested spacer.",
          specificationLinks: ["plan.spec_sheet.cube-size"],
        },
      }],
    };
    const { streamFn } = makeScriptedStreamFn([
      toolCallMessage("run-before-classification"),
      classificationCall,
      toolCallMessage("run-before-plan"),
      updatePlanCall,
      toolCallMessage("run-after-plan"),
      textMessage("The planned CAD run completed."),
      textMessage("No more work this turn."),
    ]);
    const session = createSession({
      conversationId: "conv-1",
      modelJson: JSON.stringify(FAKE_MODEL),
      systemPrompt,
      tools: [tool],
      priorMessages: [],
      __streamFn: streamFn as never,
    } as unknown as Parameters<typeof createSession>[0]);

    let latest: SessionState | undefined;
    session.subscribe((state) => (latest = state));
    vi.spyOn(crypto, "randomUUID").mockReturnValueOnce("ref-plan" as `${string}-${string}-${string}-${string}-${string}`);
    vi.mocked(rest.classifyReference).mockImplementation(async (conversationId, input) => ({
      ...input,
      id: "classification-plan",
      conversationId,
      actor: "agent",
      timestamp: 10,
    }));
    await session.send("Build the dimensioned part in this image", [new File(["image"], "drawing.png", { type: "image/png" })]);

    expect(execute).toHaveBeenCalledTimes(1);
    const rejectedRun = (latest?.messages ?? []).find((message) => {
      const result = message as { role?: string; toolCallId?: string };
      return result.role === "toolResult" && result.toolCallId === "run-before-plan";
    }) as { isError?: boolean; content?: Array<{ text?: string }> } | undefined;
    expect(rejectedRun?.isError).toBe(true);
    expect(rejectedRun?.content?.[0]?.text).toContain("update_plan");
    expect(rejectedRun?.content?.[0]?.text).toContain("spec sheet");
    expect(rejectedRun?.content?.[0]?.text).toContain("every readable dimension, feature, and spec-table row");
  });

  it("keeps pixels through CAD rejection, then evicts them only after durable classification", async () => {
    const { tool, execute } = gateTool("failed");
    const classifyCall: AssistantMessage = {
      ...textMessage("", "toolUse"),
      content: [{
        type: "toolCall",
        id: "classify-ref",
        name: "classify_reference",
        arguments: {
          referenceId: "ref-a",
          status: "active",
          purpose: "Primary drawing",
          relationships: [],
          rationale: "Defines the requested geometry.",
          specificationLinks: ["plan.spec_sheet.envelope"],
        },
      }],
    };
    const { streamFn, turnContexts } = makeScriptedStreamFn([
      toolCallMessage("premature-run"),
      classifyCall,
      toolCallMessage("classified-run"),
      textMessage("Classified CAD run completed."),
    ]);
    vi.mocked(rest.downloadAttachment).mockResolvedValue({
      type: "image",
      data: "pixels",
      mimeType: "image/png",
    });
    vi.mocked(rest.classifyReference).mockImplementation(async (conversationId, input) => ({
      ...input,
      id: "classification-1",
      conversationId,
      actor: "agent",
      timestamp: 10,
    }));
    const priorMessages = [{
      role: "user",
      content: [
        { type: "text", text: "Build this reference" },
        { type: "attachment-reference", attachmentId: "ref-a", kind: "user-image", mimeType: "image/png" },
      ],
      timestamp: 1,
    }];
    const session = createSession({
      conversationId: "conv-1",
      modelJson: JSON.stringify(FAKE_MODEL),
      systemPrompt,
      tools: [tool],
      priorMessages,
      referenceRecords: [{
        referenceId: "ref-a",
        conversationId: "conv-1",
        attachmentAvailable: true,
        status: "unclassified",
        relationships: [],
        specificationLinks: [],
        history: [],
      }],
      __streamFn: streamFn as never,
    } as unknown as Parameters<typeof createSession>[0]);

    let latest: SessionState | undefined;
    session.subscribe((state) => (latest = state));
    await session.send("Continue from the uploaded drawing");

    expect(execute).toHaveBeenCalledTimes(1);
    const rejected = (latest?.messages ?? []).find((message) =>
      (message as { role?: string; toolCallId?: string }).toolCallId === "premature-run",
    ) as { isError?: boolean; content?: Array<{ text?: string }> } | undefined;
    expect(rejected?.isError).toBe(true);
    expect(rejected?.content?.[0]?.text).toContain("classify_reference");
    expect(rejected?.content?.[0]?.text).toContain("ref-a");
    expect(rest.classifyReference).toHaveBeenCalledTimes(1);

    const imageCounts = turnContexts.map((context) => context.messages.reduce<number>((count, message) => {
      const content = (message as { content?: unknown }).content;
      return count + (Array.isArray(content)
        ? content.filter((block: { type?: string }) => block.type === "image").length
        : 0);
    }, 0));
    expect(imageCounts.slice(0, 2)).toEqual([1, 1]);
    expect(imageCounts.slice(2)).toEqual([0, 0, 0]);
    expect(JSON.stringify(turnContexts[2]?.messages)).toContain("[Reference ref-a: status=active");
  });

  it("keeps reference pixels when classification persistence fails", async () => {
    const classifyCall: AssistantMessage = {
      ...textMessage("", "toolUse"),
      content: [{
        type: "toolCall",
        id: "failed-classification",
        name: "classify_reference",
        arguments: {
          referenceId: "ref-a",
          status: "active",
          purpose: "Primary drawing",
          relationships: [],
          rationale: "Defines the requested geometry.",
          specificationLinks: ["plan.spec_sheet.envelope"],
        },
      }],
    };
    const { streamFn, turnContexts } = makeScriptedStreamFn([
      classifyCall,
      textMessage("Classification persistence failed; stopping."),
    ]);
    vi.mocked(rest.downloadAttachment).mockResolvedValue({
      type: "image",
      data: "pixels",
      mimeType: "image/png",
    });
    vi.mocked(rest.classifyReference).mockRejectedValue(new Error("classification store unavailable"));
    const session = createSession({
      conversationId: "conv-1",
      modelJson: JSON.stringify(FAKE_MODEL),
      systemPrompt,
      priorMessages: [{
        role: "user",
        content: [
          { type: "text", text: "Build this reference" },
          { type: "attachment-reference", attachmentId: "ref-a", kind: "user-image", mimeType: "image/png" },
        ],
        timestamp: 1,
      }],
      referenceRecords: [{
        referenceId: "ref-a",
        conversationId: "conv-1",
        attachmentAvailable: true,
        status: "unclassified",
        relationships: [],
        specificationLinks: [],
        history: [],
      }],
      __streamFn: streamFn as never,
    } as unknown as Parameters<typeof createSession>[0]);

    await session.send("Classify the drawing");

    expect(turnContexts).toHaveLength(2);
    for (const context of turnContexts) {
      expect(JSON.stringify(context.messages)).toContain('"type":"image"');
      expect(JSON.stringify(context.messages)).toContain("Pending reference images: ref-a");
    }
  });

  it("does not apply the plan gate to a text-only turn", async () => {
    const { tool, execute } = gateTool("failed");
    const { streamFn } = makeScriptedStreamFn([
      toolCallMessage("text-run"),
      textMessage("The CAD run completed."),
    ]);
    const session = createSession({
      conversationId: "conv-1",
      modelJson: JSON.stringify(FAKE_MODEL),
      systemPrompt,
      tools: [tool],
      priorMessages: [],
      __streamFn: streamFn as never,
    } as unknown as Parameters<typeof createSession>[0]);

    await session.send("Build a text-only box");

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("injects the self-check once after a gate pass and lets the agent continue", async () => {
    const { tool } = gateTool("passed");
    const { streamFn, turnContexts } = makeScriptedStreamFn([
      toolCallMessage("call-1"),
      textMessage("Box built; gate passed, stopping here."),
      textMessage("Checked every requirement: all satisfied."),
    ]);

    const session = createSession({
      conversationId: "conv-1",
      modelJson: JSON.stringify(FAKE_MODEL),
      systemPrompt,
      tools: [tool],
      priorMessages: [],
      __streamFn: streamFn as never,
    } as unknown as Parameters<typeof createSession>[0]);

    let latest: SessionState | undefined;
    session.subscribe((state) => (latest = state));
    await session.send("build a box with 4 holes");

    // Turn flow: toolCall -> premature stop -> injected self-check -> final answer.
    expect(turnContexts).toHaveLength(3);
    const selfChecks = (latest?.messages ?? []).filter((m) => {
      const message = m as { role?: string; content?: { type?: string; text?: string }[] };
      return (
        message.role === "user" &&
        Array.isArray(message.content) &&
        Boolean(message.content[0]?.text?.startsWith(SELF_CHECK_MARKER))
      );
    });
    expect(selfChecks).toHaveLength(1);
    const selfCheckText = (selfChecks[0] as { content: { text?: string }[] }).content[0]?.text ?? "";
    expect(selfCheckText).toContain("isometric, front, back, left, right, top, and bottom");
    expect(selfCheckText).toContain("match or mismatch verdict");
    expect(selfCheckText).toContain("evidence_id");
    expect(latest?.error).toBeUndefined();

    // The injected nudge was persisted like any other message.
    const postMessage = rest.postMessage as unknown as ReturnType<typeof vi.fn>;
    const persistedSelfCheck = postMessage.mock.calls.find((call) =>
      String(call[1].contentJson).includes("[Chamfer self-check]"),
    );
    expect(persistedSelfCheck).toBeDefined();
  });

  it("does not inject the self-check when the gate never passed", async () => {
    const { tool } = gateTool("failed");
    const { streamFn, turnContexts } = makeScriptedStreamFn([
      toolCallMessage("call-1"),
      textMessage("Gate failed; explaining honestly and stopping."),
    ]);

    const session = createSession({
      conversationId: "conv-1",
      modelJson: JSON.stringify(FAKE_MODEL),
      systemPrompt,
      tools: [tool],
      priorMessages: [],
      __streamFn: streamFn as never,
    } as unknown as Parameters<typeof createSession>[0]);

    let latest: SessionState | undefined;
    session.subscribe((state) => (latest = state));
    await session.send("build a box");

    expect(turnContexts).toHaveLength(2);
    const selfChecks = (latest?.messages ?? []).filter((m) =>
      JSON.stringify(m).includes(SELF_CHECK_MARKER),
    );
    expect(selfChecks).toHaveLength(0);
  });

  it("retries a pre-content 429, surfaces the retrying notice, and completes the turn", async () => {
    let calls = 0;
    const streamFn = vi.fn(() => {
      calls += 1;
      if (calls === 1) {
        const stream = createAssistantMessageEventStream();
        const failed: AssistantMessage = {
          ...textMessage(""),
          content: [],
          stopReason: "error",
          errorMessage: "429 too many requests, retry-after: 1",
        };
        queueMicrotask(() => {
          stream.push({ type: "start", partial: failed });
          stream.push({ type: "error", reason: "error", error: failed });
          stream.end(failed);
        });
        return stream;
      }
      return pushCompleted(textMessage("recovered"));
    });

    const session = createSession({
      conversationId: "conv-1",
      modelJson: JSON.stringify(FAKE_MODEL),
      systemPrompt,
      priorMessages: [],
      __streamFn: streamFn as never,
      __retryOptions: { sleep: () => Promise.resolve() },
    } as unknown as Parameters<typeof createSession>[0]);

    const notices: unknown[] = [];
    let latest: SessionState | undefined;
    session.subscribe((state) => {
      if (state.notice) notices.push(state.notice);
      latest = state;
    });
    await session.send("build a box");

    expect(calls).toBe(2);
    expect(latest?.error).toBeUndefined();
    expect(latest?.notice).toBeUndefined();
    expect(notices).toContainEqual({ kind: "retrying", attempt: 1, maxAttempts: 5, delaySeconds: 1 });
    const finalAssistant = (latest?.messages ?? []).at(-1) as { content?: { text?: string }[] };
    expect(finalAssistant?.content?.[0]?.text).toBe("recovered");
  });

  it("compacts an oversized history into a persisted compaction row before the turn", async () => {
    const bigText = "x".repeat(50_000 * 4);
    const priorMessages = [
      { role: "user", content: [{ type: "text", text: `Housing must be 80x60x30mm. ${bigText}` }], timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: 2 },
      { role: "user", content: [{ type: "text", text: `Wall thickness 3mm. ${bigText}` }], timestamp: 3 },
      { role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: 4 },
      { role: "user", content: [{ type: "text", text: `Add M4 holes. ${bigText}` }], timestamp: 5 },
      { role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: 6 },
      { role: "user", content: [{ type: "text", text: "small recent question" }], timestamp: 7 },
      { role: "assistant", content: [{ type: "text", text: "small recent answer" }], timestamp: 8 },
    ];
    const { streamFn, turnContexts, summaryContexts } = makeScriptedStreamFn(
      [textMessage("continuing the design")],
      "- Housing 80x60x30mm, wall 3mm.",
    );

    const session = createSession({
      conversationId: "conv-1",
      modelJson: JSON.stringify(FAKE_MODEL),
      systemPrompt,
      priorMessages,
      __streamFn: streamFn as never,
    } as unknown as Parameters<typeof createSession>[0]);

    let latest: SessionState | undefined;
    session.subscribe((state) => (latest = state));
    await session.send("now add the lid");

    // One summarization call ran, and the turn context starts with the summary.
    expect(summaryContexts).toHaveLength(1);
    expect(turnContexts).toHaveLength(1);
    const first = (turnContexts[0]?.messages ?? [])[0] as { role?: string; content?: { text?: string }[] };
    expect(first?.role).toBe("user");
    expect(first?.content?.[0]?.text).toContain("Summary of earlier work");
    expect(first?.content?.[0]?.text).toContain("80x60x30mm");
    // The turn context is much smaller than the full transcript.
    expect((turnContexts[0]?.messages ?? []).length).toBeLessThan(priorMessages.length);

    // The compaction row was persisted with the next seq, before the user prompt.
    const postMessage = rest.postMessage as unknown as ReturnType<typeof vi.fn>;
    const compactionCall = postMessage.mock.calls.find((call) => call[1].role === "compaction");
    expect(compactionCall).toBeDefined();
    expect(compactionCall?.[1].seq).toBe(priorMessages.length);
    const userCall = postMessage.mock.calls.find((call) => call[1].role === "user");
    expect(userCall?.[1].seq).toBe(priorMessages.length + 1);

    // The full transcript (plus the row) stays visible to the UI.
    expect(latest?.messages.length).toBeGreaterThan(priorMessages.length);
    // A second send must not re-summarize: the persisted row already shrank the context.
    await session.send("one more tweak");
    expect(summaryContexts).toHaveLength(1);
  });

  it("exposes only the current view sheet while the transcript keeps every image", async () => {
    const sheets = Array.from({ length: 9 }, (_, i) => ({
      role: "toolResult",
      toolCallId: `call-${i}`,
      toolName: "run_build123d",
      content: [
        { type: "text", text: `Measurements run ${i}` },
        { type: "image", data: `png-${i}`, mimeType: "image/png" },
      ],
      isError: false,
      timestamp: i,
    }));
    const { streamFn, turnContexts } = makeScriptedStreamFn([textMessage("looked at the sheets")]);

    const exposures: Array<{ totalImages: number; currentSheetImages: number; currentSheetAttachmentIds: string[] }> = [];
    const session = createSession({
      conversationId: "conv-1",
      modelJson: JSON.stringify(FAKE_MODEL),
      systemPrompt,
      priorMessages: sheets,
      __streamFn: streamFn as never,
      __onImageExposure: (trace: {
        totalImages: number;
        currentSheetImages: number;
        currentSheetAttachmentIds: string[];
      }) => exposures.push(trace),
    } as unknown as Parameters<typeof createSession>[0]);

    let latest: SessionState | undefined;
    session.subscribe((state) => (latest = state));
    await session.send("continue");

    const contextMessages = (turnContexts[0]?.messages ?? []) as { content?: { type?: string }[] }[];
    const imagesInContext = contextMessages.flatMap((m) => (m.content ?? []).filter((b) => b.type === "image"));
    expect(imagesInContext).toHaveLength(1);
    expect(exposures).toEqual([{ totalImages: 1, currentSheetImages: 1, currentSheetAttachmentIds: [] }]);

    const imagesInTranscript = (latest?.messages ?? []).flatMap((m) =>
      ((m as { content?: { type?: string }[] }).content ?? []).filter((b) => b.type === "image"),
    );
    expect(imagesInTranscript).toHaveLength(9);
  });

  it("persists artifact-to-sheet evidence on a successful CAD result", async () => {
    const tool = {
      name: "run_build123d",
      label: "Run build123d",
      description: "fake run tool",
      parameters: Type.Object({ code: Type.String() }),
      execute: vi.fn(async () => ({
        content: [
          { type: "text" as const, text: "Measurements: volume 1" },
          { type: "image" as const, data: "cG5n", mimeType: "image/png" },
        ],
        details: {
          measurements: { bboxMm: [1, 1, 1], volumeMm3: 1, areaMm2: 6, children: [] },
          gate: { status: "passed", checks: [] },
          code: { toolCallId: "run-evidence", artifactId: "artifact-7", artifactVersion: 7 },
        },
      })),
    };
    const { streamFn } = makeScriptedStreamFn([
      toolCallMessage("run-evidence"),
      textMessage("CAD complete"),
      textMessage("Checked"),
    ]);
    const session = createSession({
      conversationId: "conv-1",
      modelJson: JSON.stringify(FAKE_MODEL),
      systemPrompt,
      priorMessages: [],
      tools: [tool],
      __streamFn: streamFn as never,
    });

    await session.send("build it");

    const atomicPost = rest.postMessageWithAttachments as unknown as ReturnType<typeof vi.fn>;
    const persistedCall = atomicPost.mock.calls.find((call) => call[1].role === "toolResult");
    if (!persistedCall) throw new Error("expected persisted CAD result");
    const persisted = JSON.parse(persistedCall[1].contentJson);
    const reference = persisted.content.find((block: { type?: string }) => block.type === "attachment-reference");
    expect(persisted.details.inspectionSheet).toEqual({
      attachmentId: reference.attachmentId,
      code: { toolCallId: "run-evidence", artifactId: "artifact-7", artifactVersion: 7 },
      measurements: { bboxMm: [1, 1, 1], volumeMm3: 1, areaMm2: 6, children: [] },
      gate: { status: "passed", checks: [] },
    });
  });

  // --- plan enforcement ---

  function acceptedPlanResult(
    components: { id: string; status: string; blocked_reason?: string }[],
    interfaces: object[] = [],
  ): unknown {
    return {
      role: "toolResult",
      toolCallId: "plan-1",
      toolName: "update_plan",
      content: [{ type: "text", text: "Plan accepted" }],
      details: {
        plan: {
          goal: "test goal",
          components: components.map((c) => ({ ...c, description: c.id })),
          interfaces,
        },
      },
      isError: false,
      timestamp: 1,
    };
  }

  it("marks a gate-passed run as an error when its CHECKS weaken the active plan", async () => {
    const plan = {
      goal: "checked housing",
      components: [
        {
          id: "housing",
          description: "single housing",
          bbox_mm: [100, 80, 30],
          status: "building",
          free_floating_reason: "single part",
          checks: [
            { id: "volume", kind: "volume", range_mm3: [5000, 6000], target: "housing" },
            { id: "holes", kind: "hole_through", diameter: 6, count: 4, target: "housing" },
          ],
        },
      ],
      interfaces: [],
    };
    const tool = {
      name: "run_build123d",
      label: "Run build123d",
      description: "fake run tool",
      parameters: Type.Object({ code: Type.String() }),
      execute: vi.fn(async () => ({
        content: [{ type: "text" as const, text: "gate passed" }],
        details: {
          gate: { status: "passed", checks: [] },
          measurements: {
            component: "housing",
            checks: [{ kind: "volume", range_mm3: [4500, 6500], target: "housing" }],
          },
        },
      })),
    };
    const { streamFn } = makeScriptedStreamFn([
      toolCallWithCode("weak-run", 'COMPONENT = "housing"\nresult = Box(1, 1, 1)'),
      textMessage("The run finished."),
      textMessage("I will restore the planned checks."),
    ]);
    const session = createSession({
      conversationId: "conv-1",
      modelJson: JSON.stringify(FAKE_MODEL),
      systemPrompt,
      tools: [tool],
      priorMessages: [
        {
          role: "toolResult",
          toolCallId: "plan-1",
          toolName: "update_plan",
          content: [{ type: "text", text: "Plan accepted" }],
          details: { plan },
          isError: false,
          timestamp: 1,
        },
      ],
      __streamFn: streamFn as never,
    } as unknown as Parameters<typeof createSession>[0]);

    let latest: SessionState | undefined;
    session.subscribe((state) => (latest = state));
    await session.send("build it");

    const run = (latest?.messages ?? []).find(
      (message) =>
        (message as { role?: string; toolCallId?: string }).role === "toolResult" &&
        (message as { toolCallId?: string }).toolCallId === "weak-run",
    ) as { isError?: boolean; content?: { text?: string }[] } | undefined;
    expect(run?.isError).toBe(true);
    expect(run?.content?.[0]?.text).toContain('planned check "holes" is missing');
    expect(run?.content?.[0]?.text).toContain('planned check "volume" is weaker');
    expect(run?.content?.[0]?.text).toContain("update_plan");
    expect(countMarker(latest, SELF_CHECK_MARKER)).toBe(0);
  });

  it("names both honest exits and forbids weakening checks in the plan nudge", () => {
    const prompt = buildPlanNudgePrompt([{ id: "shell", status: "building" }]);
    expect(prompt).toContain("continue building");
    expect(prompt).toContain("mark it blocked with a non-empty blocked_reason");
    expect(prompt).toContain("Weakening checks to force closure is never acceptable");
  });

  it("nudges building components while suppressing blocked components in the same plan", async () => {
    const { streamFn, turnContexts } = makeScriptedStreamFn([textMessage("Stopping with an honest limitation.")]);
    const session = createSession({
      conversationId: "conv-1",
      modelJson: JSON.stringify(FAKE_MODEL),
      systemPrompt,
      priorMessages: [
        acceptedPlanResult([
          { id: "shell", status: "blocked", blocked_reason: "The swept shell fails kernel tessellation." },
          { id: "button", status: "building" },
        ]),
      ],
      __streamFn: streamFn as never,
    } as unknown as Parameters<typeof createSession>[0]);

    let latest: SessionState | undefined;
    session.subscribe((state) => (latest = state));
    await session.send("continue");

    expect(turnContexts).toHaveLength(2);
    const nudge = (latest?.messages ?? []).find((message) => {
      const candidate = message as { role?: string; content?: { text?: string }[] };
      return candidate.role === "user" && candidate.content?.[0]?.text?.startsWith(PLAN_NUDGE_MARKER);
    }) as { content?: { text?: string }[] } | undefined;
    expect(nudge?.content?.[0]?.text).toContain('"button" (building)');
    expect(nudge?.content?.[0]?.text).not.toContain('"shell"');
  });

  it("ends cleanly when all remaining plan work is blocked", async () => {
    const { streamFn, turnContexts } = makeScriptedStreamFn([textMessage("The loft is blocked; here is why.")]);
    const session = createSession({
      conversationId: "conv-1",
      modelJson: JSON.stringify(FAKE_MODEL),
      systemPrompt,
      priorMessages: [
        acceptedPlanResult([
          { id: "shell", status: "blocked", blocked_reason: "The swept shell fails kernel tessellation." },
        ]),
      ],
      __streamFn: streamFn as never,
    } as unknown as Parameters<typeof createSession>[0]);

    let latest: SessionState | undefined;
    session.subscribe((state) => (latest = state));
    await session.send("continue");

    expect(turnContexts).toHaveLength(1);
    expect(countMarker(latest, PLAN_NUDGE_MARKER)).toBe(0);
    expect(latest?.error).toBeUndefined();
  });

  it("pressure-loop regression: marking the stuck component blocked ends without another nudge or stop error", async () => {
    const buildingPlan = {
      goal: "organic device shell",
      components: [
        {
          id: "shell",
          description: "curved outer shell",
          bbox_mm: [120, 50, 30],
          checks: [{ id: "volume", kind: "volume", range_mm3: [5000, 6000], target: "shell" }],
          status: "building",
          free_floating_reason: "single part",
        },
      ],
      interfaces: [],
    };
    const blockedPlan = {
      ...buildingPlan,
      components: [
        {
          ...buildingPlan.components[0],
          status: "blocked",
          blocked_reason: "The curved shell repeatedly fails tessellation after alternative loft and sweep strategies.",
        },
      ],
    };
    const blockCall: AssistantMessage = {
      ...textMessage("", "toolUse"),
      content: [{ type: "toolCall", id: "block-plan", name: "update_plan", arguments: blockedPlan }],
    };
    const { streamFn, turnContexts } = makeScriptedStreamFn([
      textMessage("The curved construction is still failing."),
      blockCall,
      textMessage("The shell is blocked because the attempted curved constructions fail tessellation."),
    ]);
    const session = createSession({
      conversationId: "conv-1",
      modelJson: JSON.stringify(FAKE_MODEL),
      systemPrompt,
      priorMessages: [
        {
          role: "toolResult",
          toolCallId: "initial-plan",
          toolName: "update_plan",
          content: [{ type: "text", text: "Plan accepted" }],
          details: { plan: buildingPlan },
          isError: false,
          timestamp: 1,
        },
      ],
      __streamFn: streamFn as never,
    } as unknown as Parameters<typeof createSession>[0]);

    let latest: SessionState | undefined;
    session.subscribe((state) => (latest = state));
    await session.send("finish the shell");

    expect(turnContexts).toHaveLength(3);
    expect(countMarker(latest, PLAN_NUDGE_MARKER)).toBe(1);
    expect(latest?.error).toBeUndefined();
    const accepted = (latest?.messages ?? []).find(
      (message) =>
        (message as { role?: string; toolName?: string; details?: { plan?: { components?: { status?: string }[] } } }).role ===
          "toolResult" &&
        (message as { toolName?: string }).toolName === "update_plan" &&
        (message as { details?: { plan?: { components?: { status?: string }[] } } }).details?.plan?.components?.[0]
          ?.status === "blocked",
    ) as { details?: { plan?: { components?: { blocked_reason?: string }[] } } } | undefined;
    expect(accepted?.details?.plan?.components?.[0]?.blocked_reason).toContain("fails tessellation");
  });

  function toolCallWithCode(id: string, code: string): AssistantMessage {
    return {
      ...textMessage("", "toolUse"),
      content: [{ type: "toolCall", id, name: "run_build123d", arguments: { code } }],
    };
  }

  function countMarker(state: SessionState | undefined, marker: string): number {
    return (state?.messages ?? []).filter((m) => {
      const message = m as { role?: string; content?: { text?: string }[] };
      return (
        message.role === "user" &&
        Array.isArray(message.content) &&
        Boolean(message.content[0]?.text?.startsWith(marker))
      );
    }).length;
  }

  it("reports an incomplete plan when the one allowed nudge is ignored", async () => {
    const { streamFn, turnContexts } = makeScriptedStreamFn([
      textMessage("planned enough, stopping."),
      textMessage("still stopping without running anything."),
    ]);

    const session = createSession({
      conversationId: "conv-1",
      modelJson: JSON.stringify(FAKE_MODEL),
      systemPrompt,
      priorMessages: [acceptedPlanResult([{ id: "base", status: "todo" }])],
      __streamFn: streamFn as never,
    } as unknown as Parameters<typeof createSession>[0]);

    let latest: SessionState | undefined;
    session.subscribe((state) => (latest = state));
    await session.send("build it");

    // stop -> nudge -> stop; the second stop must NOT nudge again (no run in between).
    expect(turnContexts).toHaveLength(2);
    expect(countMarker(latest, PLAN_NUDGE_MARKER)).toBe(1);
    expect(countMarker(latest, SELF_CHECK_MARKER)).toBe(0);
    expect(latest?.error?.message).toMatch(/stopped with unfinished plan work/i);
  });

  it("re-arms the plan nudge after an intervening run_build123d call", async () => {
    const { tool } = gateTool("passed");
    const { streamFn, turnContexts } = makeScriptedStreamFn([
      textMessage("stopping early."),
      toolCallMessage("call-1"),
      textMessage("ran once, stopping again."),
      textMessage("final stop."),
    ]);

    const session = createSession({
      conversationId: "conv-1",
      modelJson: JSON.stringify(FAKE_MODEL),
      systemPrompt,
      tools: [tool],
      priorMessages: [acceptedPlanResult([{ id: "base", status: "todo" }])],
      __streamFn: streamFn as never,
    } as unknown as Parameters<typeof createSession>[0]);

    let latest: SessionState | undefined;
    session.subscribe((state) => (latest = state));
    await session.send("build it");

    // stop -> nudge -> run+stop -> nudge -> stop (no third nudge).
    expect(turnContexts).toHaveLength(4);
    expect(countMarker(latest, PLAN_NUDGE_MARKER)).toBe(2);
  });

  it("falls back to the prose self-check when the plan is complete", async () => {
    const { tool } = gateTool("passed");
    const { streamFn } = makeScriptedStreamFn([
      toolCallMessage("call-1"),
      textMessage("gate passed, stopping."),
      textMessage("final summary."),
    ]);

    const session = createSession({
      conversationId: "conv-1",
      modelJson: JSON.stringify(FAKE_MODEL),
      systemPrompt,
      tools: [tool],
      priorMessages: [acceptedPlanResult([{ id: "base", status: "done" }])],
      __streamFn: streamFn as never,
    } as unknown as Parameters<typeof createSession>[0]);

    let latest: SessionState | undefined;
    session.subscribe((state) => (latest = state));
    await session.send("build it");

    expect(countMarker(latest, PLAN_NUDGE_MARKER)).toBe(0);
    expect(countMarker(latest, SELF_CHECK_MARKER)).toBe(1);
  });

  it("demands an assembly run when every component is done but the interfaces have no evidence", async () => {
    const { streamFn, turnContexts } = makeScriptedStreamFn([
      textMessage("both components done, wrapping up."),
      textMessage("still not running the assembly."),
    ]);

    const session = createSession({
      conversationId: "conv-1",
      modelJson: JSON.stringify(FAKE_MODEL),
      systemPrompt,
      priorMessages: [
        acceptedPlanResult(
          [
            { id: "base", status: "done" },
            { id: "lid", status: "done" },
          ],
          [{ a: "base", b: "lid", kind: "clearance", min_mm: 0, max_mm: 0 }],
        ),
      ],
      __streamFn: streamFn as never,
    } as unknown as Parameters<typeof createSession>[0]);

    let latest: SessionState | undefined;
    session.subscribe((state) => (latest = state));
    await session.send("finish it");

    expect(turnContexts).toHaveLength(2);
    expect(countMarker(latest, PLAN_NUDGE_MARKER)).toBe(1);
    const nudge = (latest?.messages ?? []).find((m) =>
      JSON.stringify(m).includes("interfaces are unverified"),
    );
    expect(nudge).toBeDefined();
  });

  it("skips the assembly nudge once a gate-passed run declared all components", async () => {
    const { tool } = gateTool("passed");
    const assemblyEvidence = {
      role: "toolResult",
      toolCallId: "asm-1",
      toolName: "run_build123d",
      content: [{ type: "text", text: "ran" }],
      details: {
        gate: { status: "passed", checks: [] },
        measurements: {
          component: ["base", "lid"],
          // Assembly evidence requires the interface's clearance check to have
          // actually run; declaring the components alone is not enough.
          checks: [{ kind: "clearance", a: "base", b: "lid", min_mm: 0, max_mm: 0 }],
        },
      },
      isError: false,
      timestamp: 2,
    };
    const { streamFn } = makeScriptedStreamFn([
      toolCallMessage("call-1"),
      textMessage("assembly verified, done."),
      textMessage("final summary."),
    ]);

    const session = createSession({
      conversationId: "conv-1",
      modelJson: JSON.stringify(FAKE_MODEL),
      systemPrompt,
      tools: [tool],
      priorMessages: [
        acceptedPlanResult(
          [
            { id: "base", status: "done" },
            { id: "lid", status: "done" },
          ],
          [{ a: "base", b: "lid", kind: "clearance", min_mm: 0, max_mm: 0 }],
        ),
        assemblyEvidence,
      ],
      __streamFn: streamFn as never,
    } as unknown as Parameters<typeof createSession>[0]);

    let latest: SessionState | undefined;
    session.subscribe((state) => (latest = state));
    await session.send("finish it");

    expect(countMarker(latest, PLAN_NUDGE_MARKER)).toBe(0);
    expect(countMarker(latest, SELF_CHECK_MARKER)).toBe(1);
  });

  it("with an active plan, budgets runs per component bucket and aborts the bucket's overflow run", async () => {
    const { tool, execute } = gateTool("passed");
    const baseRun = (i: number) => toolCallWithCode(`call-${i}`, `COMPONENT = "base"\nresult = Box(1, 1, ${i})`);
    const { streamFn } = makeScriptedStreamFn([
      baseRun(1),
      baseRun(2),
      baseRun(3),
      textMessage("should have been aborted"),
    ]);

    const session = createSession({
      conversationId: "conv-1",
      modelJson: JSON.stringify(FAKE_MODEL),
      systemPrompt,
      tools: [tool],
      priorMessages: [acceptedPlanResult([{ id: "base", status: "todo" }])],
      maxCadRuns: 2,
      __streamFn: streamFn as never,
    } as unknown as Parameters<typeof createSession>[0]);

    let latest: SessionState | undefined;
    session.subscribe((state) => (latest = state));
    await session.send("build it");

    expect(execute).toHaveBeenCalledTimes(2);
    expect(latest?.error?.message).toContain('Stopped after 2 CAD runs for plan component "base"');
  });

  it("probe runs drain only the global ceiling, never a component bucket", async () => {
    const { tool, execute } = gateTool("passed");
    const { streamFn } = makeScriptedStreamFn([
      toolCallWithCode("call-1", 'COMPONENT = "probe"\nresult = Box(1, 1, 1)'),
      toolCallWithCode("call-2", 'COMPONENT = "base"\nresult = Box(1, 1, 2)'),
      toolCallWithCode("call-3", 'COMPONENT = "base"\nresult = Box(1, 1, 3)'),
      textMessage("done"),
    ]);

    const session = createSession({
      conversationId: "conv-1",
      modelJson: JSON.stringify(FAKE_MODEL),
      systemPrompt,
      tools: [tool],
      priorMessages: [acceptedPlanResult([{ id: "base", status: "todo" }])],
      maxCadRuns: 1,
      __streamFn: streamFn as never,
    } as unknown as Parameters<typeof createSession>[0]);

    let latest: SessionState | undefined;
    session.subscribe((state) => (latest = state));
    await session.send("build it");

    // Probe + one base run execute; the second base run trips the bucket (1).
    expect(execute).toHaveBeenCalledTimes(2);
    expect(latest?.error?.message).toContain('plan component "base"');
  });

  it("registers update_plan so the agent can create a plan, and the accepted snapshot persists in the tool result", async () => {
    const plan = {
      goal: "single spacer",
      components: [
        {
          id: "spacer",
          description: "a spacer",
          bbox_mm: [10, 10, 10],
          status: "todo",
          free_floating_reason: "single part",
          checks: [{ id: "volume", kind: "volume", range_mm3: [900, 1100], target: "spacer" }],
        },
      ],
      interfaces: [],
    };
    const { streamFn } = makeScriptedStreamFn([
      {
        ...textMessage("", "toolUse"),
        content: [{ type: "toolCall", id: "plan-call", name: "update_plan", arguments: plan }],
      },
      textMessage("planned, stopping."),
      textMessage("continuing after nudge."),
    ]);

    const session = createSession({
      conversationId: "conv-1",
      modelJson: JSON.stringify(FAKE_MODEL),
      systemPrompt,
      priorMessages: [],
      __streamFn: streamFn as never,
    } as unknown as Parameters<typeof createSession>[0]);

    let latest: SessionState | undefined;
    session.subscribe((state) => (latest = state));
    await session.send("make a spacer");

    const planResults = (latest?.messages ?? []).filter((m) => {
      const message = m as { role?: string; toolName?: string; isError?: boolean; details?: { plan?: unknown } };
      return message.role === "toolResult" && message.toolName === "update_plan" && !message.isError;
    });
    expect(planResults).toHaveLength(1);
    expect((planResults[0] as { details: { plan: { goal: string } } }).details.plan.goal).toBe("single spacer");
    // The new plan is live immediately: stopping with a todo component draws the nudge.
    expect(countMarker(latest, PLAN_NUDGE_MARKER)).toBe(1);
  });

  function loadSkillCall(id: string, name = "sweep-and-loft"): AssistantMessage {
    return {
      ...textMessage("", "toolUse"),
      content: [{ type: "toolCall", id, name: "load_skill", arguments: { name } }],
    };
  }

  function resultFor(latest: SessionState | undefined, toolCallId: string) {
    return (latest?.messages ?? []).find((message) => {
      const result = message as { role?: string; toolCallId?: string };
      return result.role === "toolResult" && result.toolCallId === toolCallId;
    }) as { isError?: boolean; content?: Array<{ type?: string; text?: string }>; details?: unknown } | undefined;
  }

  it("appends the skill hint to the second matching failure of a turn, not the first", async () => {
    const sweepFailure = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "Verify gate: FAILED\n- bodies: sweep produced 2 solids" }],
      details: { gate: { status: "failed", checks: [] } },
    }));
    const tool = {
      name: "run_build123d",
      label: "Run build123d",
      description: "fake run tool",
      parameters: Type.Object({ code: Type.String() }),
      execute: sweepFailure,
    };
    const { streamFn } = makeScriptedStreamFn([
      toolCallMessage("sweep-run-1"),
      toolCallMessage("sweep-run-2"),
      textMessage("stopping after two failures."),
    ]);
    const session = createSession({
      conversationId: "conv-1",
      modelJson: JSON.stringify(FAKE_MODEL),
      systemPrompt,
      tools: [tool],
      priorMessages: [],
      __streamFn: streamFn as never,
    } as unknown as Parameters<typeof createSession>[0]);

    let latest: SessionState | undefined;
    session.subscribe((state) => (latest = state));
    await session.send("sweep a handle profile along an arc");

    const first = resultFor(latest, "sweep-run-1");
    const second = resultFor(latest, "sweep-run-2");
    const textOf = (result: typeof first) => (result?.content ?? []).map((block) => block.text ?? "").join("\n");
    expect(textOf(first)).not.toContain("Skill hint:");
    expect(textOf(second)).toContain('Skill hint: load_skill("sweep-and-loft") covers this failure pattern.');
  });

  it("reaches the disjoint-solids recipe in one load after the repeated session-derived gate failure", async () => {
    const multipleBodies = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "Verify gate: FAILED\n- bodies: expected 1, found 3" }],
      details: { gate: { status: "failed", checks: [] } },
    }));
    const tool = {
      name: "run_build123d",
      label: "Run build123d",
      description: "fake run tool",
      parameters: Type.Object({ code: Type.String() }),
      execute: multipleBodies,
    };
    const { streamFn } = makeScriptedStreamFn([
      toolCallMessage("boss-run-1"),
      toolCallMessage("boss-run-2"),
      loadSkillCall("boss-recovery", "recover-disjoint-solids"),
      textMessage("I will preserve and overlap the bosses."),
    ]);
    const session = createSession({
      conversationId: "conv-boss-recovery",
      modelJson: JSON.stringify(FAKE_MODEL),
      systemPrompt,
      tools: [tool],
      priorMessages: [],
      __streamFn: streamFn as never,
    } as unknown as Parameters<typeof createSession>[0]);

    let latest: SessionState | undefined;
    session.subscribe((state) => (latest = state));
    await session.send("add two internal bosses");

    const secondFailure = resultFor(latest, "boss-run-2");
    const failureText = (secondFailure?.content ?? []).map((block) => block.text ?? "").join("\n");
    expect(failureText).toContain('load_skill("recover-disjoint-solids")');

    const recovery = resultFor(latest, "boss-recovery");
    const recoveryText = (recovery?.content ?? []).map((block) => block.text ?? "").join("\n");
    expect(recoveryText).toContain("Never abandon the feature");
    expect(recovery?.details).toEqual({ skill: "recover-disjoint-solids", loaded: true });
  });

  it("serves load_skill in the default treatment and withholds it from the pre-skill arms", async () => {
    const runArm = async (skillMode: string, callId: string) => {
      const { streamFn } = makeScriptedStreamFn([loadSkillCall(callId), textMessage("done.")]);
      const session = createSession({
        conversationId: "conv-1",
        modelJson: JSON.stringify(FAKE_MODEL),
        systemPrompt,
        priorMessages: [],
        skillMode,
        __streamFn: streamFn as never,
      } as unknown as Parameters<typeof createSession>[0]);
      let latest: SessionState | undefined;
      session.subscribe((state) => (latest = state));
      await session.send("load the sweep skill");
      return resultFor(latest, callId);
    };

    const catalogResult = await runArm("catalog", "load-catalog");
    expect(catalogResult?.isError).toBeFalsy();
    expect(catalogResult?.content?.[0]?.text).toContain('<skill name="sweep-and-loft"');
    expect(catalogResult?.details).toMatchObject({ skill: "sweep-and-loft", loaded: true });

    const coreResult = await runArm("core", "load-core");
    expect(coreResult?.isError).toBe(true);
  });
});
