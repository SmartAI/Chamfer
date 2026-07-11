import { describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import { findCompactionCut, needsCompaction, runCompaction } from "./compaction";
import { isCompactionMessage } from "./contextPolicy";

const MODEL = {
  id: "fake",
  api: "anthropic-messages" as Api,
  provider: "anthropic",
  contextWindow: 100_000,
} as Model<Api>;

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** A user message of roughly `tokens` estimated tokens (4 chars per token). */
function bigUser(tokens: number, label: string): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text: `${label} ${"x".repeat(tokens * 4)}` }],
    timestamp: 0,
  } as AgentMessage;
}

function user(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: 0 } as AgentMessage;
}

function assistant(text: string): AgentMessage {
  return { role: "assistant", content: [{ type: "text", text }], timestamp: 0 } as unknown as AgentMessage;
}

function gateResult(status: string): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "run_build123d",
    content: [{ type: "text", text: "Measurements: {}" }],
    details: { gate: { status, checks: [] } },
    isError: false,
    timestamp: 0,
  } as unknown as AgentMessage;
}

function summaryStreamFn(summaryText: string): StreamFn {
  return vi.fn(() => {
    const stream = createAssistantMessageEventStream();
    const final = {
      role: "assistant",
      content: [{ type: "text", text: summaryText }],
      api: MODEL.api,
      provider: MODEL.provider,
      model: MODEL.id,
      usage: ZERO_USAGE,
      stopReason: "stop",
      timestamp: 1,
    } as AssistantMessage;
    queueMicrotask(() => {
      stream.push({ type: "start", partial: final });
      stream.push({ type: "done", reason: "stop", message: final });
    });
    return stream;
  });
}

describe("needsCompaction", () => {
  it("stays quiet under the threshold and fires above it", () => {
    // Threshold: contextWindow 100k - reserveTokens 16384 = 83616 estimated tokens.
    expect(needsCompaction([bigUser(50_000, "small")], MODEL)).toBeUndefined();
    const result = needsCompaction([bigUser(90_000, "large")], MODEL);
    expect(result).toBeDefined();
    expect(result!.tokens).toBeGreaterThan(83_616);
  });
});

describe("findCompactionCut", () => {
  it("keeps roughly the recent-token budget and starts the kept tail at a user turn", () => {
    const messages = [
      user("turn 1"),
      assistant("reply 1"),
      bigUser(15_000, "turn 2"),
      assistant("reply 2"),
      bigUser(15_000, "turn 3"),
      assistant("reply 3"),
    ];
    const cut = findCompactionCut(messages, 0, 10_000);
    // Walking back: reply 3 + turn 3 crosses the 10k budget at turn 3's user message.
    expect(cut).toBe(4);
  });

  it("never cuts past the newest gate verdict", () => {
    const messages = [
      user("turn 1"),
      assistant("reply 1"),
      user("build it"),
      gateResult("passed"),
      bigUser(30_000, "later chatter"),
      assistant("reply"),
    ];
    const cut = findCompactionCut(messages, 0, 1_000);
    // Budget alone would keep only the tail, but the gate result pulls the cut
    // back to the start of its turn.
    expect(cut).toBe(2);
  });

  it("returns the floor when no user boundary exists above it", () => {
    const messages = [assistant("only assistant")];
    expect(findCompactionCut(messages, 0, 10)).toBe(0);
  });
});

describe("runCompaction", () => {
  it("returns undefined when the context is comfortably small", async () => {
    const row = await runCompaction({
      messages: [user("hi"), assistant("hello")],
      model: MODEL,
      streamFn: summaryStreamFn("unused"),
    });
    expect(row).toBeUndefined();
  });

  it("summarizes the pre-cut history into a compaction row with the right keptTail", async () => {
    const messages = [
      user("Design a gearbox housing 80x60x30mm"),
      assistant("Working on it"),
      bigUser(45_000, "more requirements"),
      assistant("ack"),
      bigUser(45_000, "even more"),
      assistant("ack 2"),
      user("final tweak"),
      assistant("done"),
    ];
    const streamFn = summaryStreamFn("- Housing 80x60x30mm; steps 1-2 gate-passed.");
    const row = await runCompaction({ messages, model: MODEL, streamFn });

    expect(row).toBeDefined();
    expect(isCompactionMessage(row)).toBe(true);
    expect(row!.summary).toContain("80x60x30mm");
    expect(row!.keptTail).toBeGreaterThan(0);
    expect(row!.keptTail).toBeLessThan(messages.length);
    expect(row!.tokensBefore).toBeGreaterThan(80_000);

    // The summary request carried the domain instructions and the old conversation.
    const call = (streamFn as ReturnType<typeof vi.fn>).mock.calls[0];
    const request = call?.[1] as { systemPrompt: string; messages: { content: { text: string }[] }[] };
    expect(request.systemPrompt).toContain("context summarization assistant");
    const prompt = request.messages[0]?.content[0]?.text ?? "";
    expect(prompt).toContain("gearbox housing");
    expect(prompt).toContain("Never round, drop, or paraphrase a number");
  });

  it("folds the previous summary in when compacting a second time", async () => {
    const previous = {
      role: "compaction",
      summary: "Earlier: user wants M4 holes.",
      keptTail: 1,
      tokensBefore: 90_000,
      timestamp: 1,
    } as unknown as AgentMessage;
    const messages = [
      user("ancient"),
      previous,
      user("mid question"),
      assistant("mid answer"),
      bigUser(45_000, "wave 2 requirements"),
      assistant("ack"),
      bigUser(45_000, "wave 3"),
      assistant("ack"),
      user("recent"),
      assistant("done"),
    ];
    const streamFn = summaryStreamFn("- M4 holes; wave 2-3 folded in.");
    const row = await runCompaction({ messages, model: MODEL, streamFn });

    expect(row).toBeDefined();
    const call = (streamFn as ReturnType<typeof vi.fn>).mock.calls[0];
    const prompt = (call?.[1] as { messages: { content: { text: string }[] }[] }).messages[0]?.content[0]?.text ?? "";
    expect(prompt).toContain("Previous summary of even earlier work");
    expect(prompt).toContain("M4 holes");
  });

  it("throws when the summary call fails (caller skips compaction)", async () => {
    const streamFn: StreamFn = () => {
      const stream = createAssistantMessageEventStream();
      const failed = {
        role: "assistant",
        content: [],
        api: MODEL.api,
        provider: MODEL.provider,
        model: MODEL.id,
        usage: ZERO_USAGE,
        stopReason: "error",
        errorMessage: "boom",
        timestamp: 1,
      } as AssistantMessage;
      queueMicrotask(() => {
        stream.push({ type: "error", reason: "error", error: failed });
      });
      return stream;
    };
    const messages = [
      bigUser(30_000, "h1"),
      assistant("a"),
      bigUser(30_000, "h2"),
      assistant("b"),
      bigUser(30_000, "h3"),
      assistant("c"),
      user("tail"),
      assistant("d"),
    ];
    await expect(runCompaction({ messages, model: MODEL, streamFn })).rejects.toThrow("boom");
  });
});
