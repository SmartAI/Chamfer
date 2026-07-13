import { describe, expect, it } from "vitest";
import { toProxyEvent } from "./proxyEvents";

describe("toProxyEvent", () => {
  it("strips partial from delta events", () => {
    const out = toProxyEvent({ type: "text_delta", contentIndex: 0, delta: "hi", partial: { big: "object" } } as never);
    expect(out).toEqual({ type: "text_delta", contentIndex: 0, delta: "hi" });
  });
  it("maps done events to reason + usage", () => {
    const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    const out = toProxyEvent({ type: "done", message: { stopReason: "stop", usage } } as never);
    expect(out).toEqual({ type: "done", reason: "stop", usage });
  });

  it("maps toolcall_start by pulling id/toolName from partial.content[contentIndex]", () => {
    const out = toProxyEvent({
      type: "toolcall_start",
      contentIndex: 1,
      partial: {
        role: "assistant",
        content: [
          { type: "text", text: "let me check" },
          { type: "toolCall", id: "call_abc123", name: "get_weather", arguments: {} },
        ],
      },
    } as never);
    expect(out).toEqual({ type: "toolcall_start", contentIndex: 1, id: "call_abc123", toolName: "get_weather" });
  });

  it("keeps delta and strips partial for toolcall_delta", () => {
    const out = toProxyEvent({
      type: "toolcall_delta",
      contentIndex: 1,
      delta: '{"location":"S',
      partial: { role: "assistant", content: [] },
    } as never);
    expect(out).toEqual({ type: "toolcall_delta", contentIndex: 1, delta: '{"location":"S' });
  });

  it("forwards the complete tool call on toolcall_end", () => {
    const toolCall = {
      type: "toolCall",
      id: "call_abc123",
      name: "get_weather",
      arguments: { location: "SF" },
      thoughtSignature: "dGhvdWdodC1zaWduYXR1cmU=",
    } as const;
    const out = toProxyEvent({
      type: "toolcall_end",
      contentIndex: 1,
      toolCall,
      partial: { role: "assistant", content: [] },
    } as never);
    expect(out).toEqual({ type: "toolcall_end", contentIndex: 1, toolCall });
  });

  it("forwards text and thinking signatures on end events", () => {
    expect(toProxyEvent({
      type: "text_end",
      contentIndex: 0,
      partial: { content: [{ type: "text", text: "answer", textSignature: "text-signature" }] },
    } as never)).toEqual({ type: "text_end", contentIndex: 0, contentSignature: "text-signature" });
    expect(toProxyEvent({
      type: "thinking_end",
      contentIndex: 0,
      partial: { content: [{ type: "thinking", thinking: "reasoning", thinkingSignature: "thinking-signature" }] },
    } as never)).toEqual({ type: "thinking_end", contentIndex: 0, contentSignature: "thinking-signature" });
  });

  it("maps done events with stopReason toolUse to reason toolUse", () => {
    const usage = { input: 5, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    const out = toProxyEvent({ type: "done", message: { stopReason: "toolUse", usage } } as never);
    expect(out).toEqual({ type: "done", reason: "toolUse", usage });
  });
});
