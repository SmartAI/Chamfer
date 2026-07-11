import { describe, expect, it } from "vitest";
import { turnStats } from "./turnStats";

function assistantWithToolCalls(...names: string[]) {
  return {
    role: "assistant",
    content: names.map((name, index) => ({ type: "toolCall", id: `call-${name}-${index}`, name, arguments: {} })),
  };
}

describe("turnStats", () => {
  it("returns zeros for an empty conversation", () => {
    expect(turnStats([])).toEqual({ llmCalls: 0, cadRunsThisTurn: 0 });
  });

  it("counts every assistant message as one LLM call, including the streaming partial", () => {
    const messages = [
      { role: "user", content: "make a box" },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "toolResult", toolName: "run_build123d", content: [] },
      { role: "assistant", content: [{ type: "text", text: "still going" }] },
    ];
    expect(turnStats(messages).llmCalls).toBe(2);
  });

  it("counts run_build123d tool calls only after the most recent user message", () => {
    const messages = [
      { role: "user", content: "make a box" },
      assistantWithToolCalls("run_build123d", "run_build123d"),
      { role: "user", content: "now add a hole" },
      assistantWithToolCalls("run_build123d", "lookup_docs"),
      assistantWithToolCalls("run_build123d"),
    ];
    expect(turnStats(messages).cadRunsThisTurn).toBe(2);
  });

  it("tolerates malformed messages", () => {
    const messages = [null, 42, { role: "assistant" }, { role: "assistant", content: "plain" }];
    expect(turnStats(messages)).toEqual({ llmCalls: 2, cadRunsThisTurn: 0 });
  });
});
