import { describe, expect, it } from "vitest";
import { resolveAblationSkill, scoreAblationMessages } from "./ablation";

const assistant = (name: string, arguments_: object, usage = { input: 100, output: 20 }) => ({
  role: "assistant",
  content: [{ type: "toolCall", id: `${name}-1`, name, arguments: arguments_ }],
  usage,
});

const toolResult = (toolName: string, text: string) => ({
  role: "toolResult",
  toolName,
  content: [{ type: "text", text }],
});

describe("ablation session scoring", () => {
  it("accepts skill treatments only in development", () => {
    expect(resolveAblationSkill("?chamferSkill=none", true)).toBe("none");
    expect(resolveAblationSkill("?chamferSkill=full", true)).toBe("full");
    expect(resolveAblationSkill("?chamferSkill=invalid", true)).toBe("core");
    expect(resolveAblationSkill("?chamferSkill=none", false)).toBe("core");
  });

  it("scores gate outcomes, tool use, tokens, and repeated failures", () => {
    const score = scoreAblationMessages([
      assistant("run_build123d", { code: "result = Box(1, 1, 1)" }),
      toolResult("run_build123d", "Verify gate: FAILED\n- bodies: expected 1, found 3"),
      assistant("search_docs", { query: "sweep profile path plane" }, { input: 50, output: 10 }),
      toolResult("search_docs", "## BuildLine to BuildPart"),
      assistant("run_build123d", { code: "result = Box(1, 1, 1)" }),
      toolResult("run_build123d", "Verify gate: FAILED\n- bodies: expected 1, found 2"),
      assistant("run_build123d", { code: "result = Box(1, 1, 1)" }),
      toolResult("run_build123d", "Verify gate: PASSED"),
    ]);

    expect(score).toEqual({
      gatePassed: true,
      cadRuns: 3,
      searches: 1,
      inputTokens: 350,
      outputTokens: 70,
      failureCategories: { bodies: 2 },
      repeatedFailureCategories: ["bodies"],
    });
  });
});
