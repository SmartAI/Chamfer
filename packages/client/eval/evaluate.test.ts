import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluatePersistedCase } from "./evaluate";
import { loadEvaluationCase } from "./schema";

function persisted(content: unknown, seq: number) {
  return { id: `message-${seq}`, conversationId: "conversation-1", seq, contentJson: JSON.stringify(content) };
}

describe("persisted case evaluation", () => {
  it("scores the precise box from durable production evidence", async () => {
    const evaluationCase = await loadEvaluationCase(
      resolve(import.meta.dirname, "cases/v1/precise-box.case.json"),
    );
    const messages = [
      persisted({ role: "user", content: "Make a box.", timestamp: 1 }, 1),
      persisted({
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "run_build123d", arguments: {} }],
        usage: {
          input: 12,
          output: 8,
          cacheRead: 3,
          cacheWrite: 2,
          reasoning: 1,
          cost: { total: 0.04 },
        },
        stopReason: "toolUse",
      }, 2),
      persisted({
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "run_build123d",
        content: [{ type: "text", text: "Verify gate: PASSED" }],
        details: {
          measurements: { bboxMm: [10, 20, 30], volumeMm3: 6000, areaMm2: 2200, children: [] },
          gate: { status: "passed", checks: [{ name: "bodies", passed: true, detail: "one body" }] },
          code: { toolCallId: "call-1", artifactId: "artifact-1", artifactVersion: 1 },
        },
        isError: false,
      }, 3),
      persisted({
        role: "assistant",
        content: [{ type: "text", text: "The box is complete." }],
        usage: {
          input: 15,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          reasoning: 0,
          cost: { total: 0.01 },
        },
        stopReason: "stop",
      }, 4),
    ];

    const evaluated = evaluatePersistedCase({
      evaluationCase,
      conversationId: "conversation-1",
      messages,
      artifacts: [{ id: "artifact-1", version: 1 }],
    });

    expect(evaluated.outcome).toEqual({ kind: "completed", expectedMatch: true });
    expect(evaluated.measurements).toMatchObject({
      gatePassed: true,
      boundingBoxMm: [10, 20, 30],
      cadRuns: 1,
      modelCalls: 2,
      toolCalls: 1,
      toolErrors: 0,
      searches: 0,
      skillLoads: 0,
      compactions: 0,
      inputTokens: 27,
      outputTokens: 13,
      cacheReadTokens: 3,
      cacheWriteTokens: 2,
      reasoningTokens: 1,
      providerCost: 0.05,
    });
    expect(evaluated.scores.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: "verification-gate", status: "passed" },
      { id: "bbox", status: "passed" },
      { id: "gate-checks", status: "passed" },
    ]);
    expect(evaluated.evidence.map((evidence) => evidence.reference)).toEqual([
      "conversation:conversation-1",
      "artifact:artifact-1:1",
      "conversation:conversation-1:gate",
      "conversation:conversation-1:geometry",
    ]);
  });
});
