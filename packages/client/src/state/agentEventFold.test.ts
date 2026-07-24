import { describe, expect, it } from "vitest";
import {
  applyAgentStreamEvent,
  EMPTY_SESSION_STATE,
  type SessionState,
} from "./agentEventFold";

function fold(events: Array<Record<string, unknown> & { type: string }>, from: SessionState = EMPTY_SESSION_STATE) {
  return events.reduce(applyAgentStreamEvent, from);
}

const assistant = (overrides: Record<string, unknown> = {}) => ({
  role: "assistant",
  content: [{ type: "text", text: "working" }],
  ...overrides,
});

describe("the optimistic prompt bridges the cold-start wait", () => {
  const submitting: SessionState = { ...EMPTY_SESSION_STATE, submitting: true, pendingPrompt: "make a box" };

  it("agent_start keeps the optimistic bubble (pi echoes the prompt a beat later)", () => {
    const state = applyAgentStreamEvent(submitting, { type: "agent_start" });
    expect(state.streaming).toBe(true);
    expect(state.submitting).toBe(true);
    expect(state.pendingPrompt).toBe("make a box");
  });

  it("hands off to pi's echoed user message with no gap or duplicate", () => {
    // agent_start then the echoed user message: exactly one user bubble survives.
    const state = fold(
      [
        { type: "agent_start" },
        { type: "message_start", message: { role: "user", content: [{ type: "text", text: "make a box" }] } },
      ],
      submitting,
    );
    expect(state.submitting).toBe(false);
    expect(state.pendingPrompt).toBeUndefined();
    expect(state.messages).toHaveLength(1);
    expect((state.messages[0] as { role: string }).role).toBe("user");
  });

  it("a running connect snapshot clears it; an idle one leaves it (turn not yet live)", () => {
    expect(applyAgentStreamEvent(submitting, { type: "agent_status", running: true }).submitting).toBe(false);
    const idle = applyAgentStreamEvent(submitting, { type: "agent_status", running: false });
    expect(idle.submitting).toBe(true);
    expect(idle.pendingPrompt).toBe("make a box");
  });

  it("agent_error while waiting on a cold start clears the hint and surfaces the failure", () => {
    const state = applyAgentStreamEvent(submitting, { type: "agent_error", message: "boom" });
    expect(state.submitting).toBe(false);
    expect(state.pendingPrompt).toBeUndefined();
    expect(state.streaming).toBe(false);
    expect(state.error?.message).toBe("boom");
  });
});

describe("turn status keys only on agent lifecycle events", () => {
  it("message_end mid-turn does NOT mark the turn idle", () => {
    const state = fold([
      { type: "agent_start" },
      { type: "message_start", message: assistant() },
      { type: "message_end", message: assistant({ stopReason: "toolUse" }) },
    ]);
    expect(state.streaming).toBe(true);
  });

  it("turn_end and a long silent tool call do NOT mark the turn idle", () => {
    const state = fold([
      { type: "agent_start" },
      { type: "turn_end", message: assistant(), toolResults: [] },
      { type: "tool_execution_start", toolCallId: "t1", toolName: "fusion_mcp_execute", args: {} },
      // ... minutes of SSE silence here ...
    ]);
    expect(state.streaming).toBe(true);
    expect(state.activeTool?.name).toBe("fusion_mcp_execute");
  });

  it("a mid-run assistant stopReason error does not surface failure or idle (pi retries it)", () => {
    const state = fold([
      { type: "agent_start" },
      { type: "message_end", message: assistant({ stopReason: "error", errorMessage: "overloaded" }) },
      { type: "agent_end", willRetry: true, messages: [] },
    ]);
    expect(state.streaming).toBe(true);
    expect(state.error).toBeUndefined();
  });

  it("agent_end alone does NOT mark the turn idle (a continuation may follow)", () => {
    const state = fold([
      { type: "agent_start" },
      { type: "tool_execution_start", toolCallId: "t1", toolName: "execute", args: {} },
      { type: "agent_end", willRetry: false, messages: [assistant({ stopReason: "stop" })] },
    ]);
    // Still streaming: only agent_settled ends the turn. The active tool is
    // cleared because this internal run finished.
    expect(state.streaming).toBe(true);
    expect(state.activeTool).toBeUndefined();
    expect(state.error).toBeUndefined();
  });

  it("agent_settled after agent_end marks the turn idle and clears the active tool", () => {
    const state = fold([
      { type: "agent_start" },
      { type: "tool_execution_start", toolCallId: "t1", toolName: "execute", args: {} },
      { type: "agent_end", willRetry: false, messages: [assistant({ stopReason: "stop" })] },
      { type: "agent_settled" },
    ]);
    expect(state.streaming).toBe(false);
    expect(state.activeTool).toBeUndefined();
    expect(state.error).toBeUndefined();
  });

  it("a continuation (agent_start after agent_end) keeps streaming and discards the held error", () => {
    // Overflow compact-and-retry: a run-final error is recovered by the next
    // run, so the error candidate held at agent_end must not surface.
    const state = fold([
      { type: "agent_start" },
      { type: "agent_end", willRetry: false, messages: [assistant({ stopReason: "error", errorMessage: "context overflow" })] },
      { type: "agent_start" },
    ]);
    expect(state.streaming).toBe(true);
    expect(state.error).toBeUndefined();
    expect(state.pendingError).toBeUndefined();
  });

  it("agent_settled surfaces the terminal assistant error held at agent_end", () => {
    const state = fold([
      { type: "agent_start" },
      { type: "agent_end", willRetry: false, messages: [assistant({ stopReason: "error", errorMessage: "429 rate limit" })] },
      { type: "agent_settled" },
    ]);
    expect(state.streaming).toBe(false);
    expect(state.error).toEqual({ kind: "rate-limited", message: "429 rate limit" });
  });

  it("agent_error marks idle with a classified error", () => {
    const state = fold([
      { type: "agent_start" },
      { type: "agent_error", message: "invalid api key" },
    ]);
    expect(state.streaming).toBe(false);
    expect(state.error?.kind).toBe("invalid-key");
  });
});

describe("active tool affordance", () => {
  it("tool_execution_start sets and tool_execution_end clears the active tool", () => {
    const running = fold([
      { type: "agent_start" },
      { type: "tool_execution_start", toolCallId: "t1", toolName: "fusion_mcp_execute", args: {} },
    ]);
    expect(running.activeTool?.name).toBe("fusion_mcp_execute");
    expect(typeof running.activeTool?.startedAt).toBe("number");

    const done = applyAgentStreamEvent(running, {
      type: "tool_execution_end",
      toolCallId: "t1",
      toolName: "fusion_mcp_execute",
      result: {},
      isError: false,
    });
    expect(done.activeTool).toBeUndefined();
    expect(done.streaming).toBe(true);
  });
});

describe("agent_status connect snapshot", () => {
  it("initializes a mid-turn connect as running with the active tool", () => {
    const state = applyAgentStreamEvent(EMPTY_SESSION_STATE, {
      type: "agent_status",
      running: true,
      startedAt: 123,
      activeTool: { name: "fusion_mcp_execute", startedAt: 456 },
    });
    expect(state.streaming).toBe(true);
    expect(state.activeTool).toEqual({ name: "fusion_mcp_execute", startedAt: 456 });
  });

  it("initializes an idle connect as not running", () => {
    const state = applyAgentStreamEvent(
      { ...EMPTY_SESSION_STATE, streaming: true, activeTool: { name: "execute", startedAt: 1 } },
      { type: "agent_status", running: false },
    );
    expect(state.streaming).toBe(false);
    expect(state.activeTool).toBeUndefined();
  });
});

describe("message folding", () => {
  it("replaces the live partial across update and end", () => {
    const state = fold([
      { type: "message_start", message: assistant({ content: [{ type: "text", text: "a" }] }) },
      { type: "message_update", message: assistant({ content: [{ type: "text", text: "ab" }] }) },
      { type: "message_end", message: assistant({ content: [{ type: "text", text: "abc" }] }) },
    ], { ...EMPTY_SESSION_STATE, messages: [{ role: "user", content: "hi" }] });
    expect(state.messages).toHaveLength(2);
    expect((state.messages[1] as { content: Array<{ text: string }> }).content[0]!.text).toBe("abc");
  });

  it("appends instead of overwriting history when an update arrives without its start (reconnect)", () => {
    const history: SessionState = { ...EMPTY_SESSION_STATE, messages: [{ role: "user", content: "hi" }] };
    const state = applyAgentStreamEvent(history, {
      type: "message_update",
      message: assistant({ content: [{ type: "text", text: "partial" }] }),
    });
    expect(state.messages).toHaveLength(2);
    expect((state.messages[0] as { role: string }).role).toBe("user");
  });
});
