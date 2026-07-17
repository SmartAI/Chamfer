import { describe, expect, it } from "vitest";
import { buildOfflineExperimentCohort } from "./offlineCohort";
import type { EvaluationCase } from "./schema";
import type { EvaluationResult } from "./result";

describe("offline Langfuse cohort projection", () => {
  it("projects structural case evidence and layered measurements without raw conversation content", () => {
    const evaluationCase = {
      id: "case-a",
      version: 1,
      modality: "text",
      complexity: "smoke",
      categories: ["construction"],
      purpose: "Verify a controlled task.",
      gatingStatus: "release",
      inputs: { turns: [{ role: "user", text: "Build a synthetic box." }], assets: [] },
      expectedOutcome: { kind: "completed", requirements: [] },
    } as unknown as EvaluationCase;
    const result = {
      identities: {
        corpus: { id: "corpus", version: 1, hash: "sha256:corpus" },
        case: { id: "case-a", version: 1 },
        agentConfiguration: {
          hash: "sha256:agent",
          gitCommit: "a".repeat(40),
          provider: "fixture",
          model: "fixture-model",
        },
        evaluators: [{ id: "gate", version: 1, hash: "sha256:evaluator" }],
        rubrics: [{ id: "intent", version: 1, hash: "sha256:rubric" }],
        runner: { version: 1, hash: "sha256:runner" },
        repetition: { index: 1, hash: "sha256:repetition-1" },
      },
      execution: { state: "completed", durationMs: 100 },
      outcome: { kind: "completed", expectedMatch: true },
      evidence: [{ id: "gate", kind: "verification-gate", reference: "private-reference" }],
      measurements: {
        providerCost: 0.01,
        modelCalls: 1,
        toolCalls: 1,
        cadRuns: 1,
        toolErrors: 0,
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
      },
      scores: [{ id: "gate", evaluatorVersion: 1, status: "passed", required: true, value: 1, evidenceIds: ["gate"] }],
      integrity: { violations: [] },
    } as unknown as EvaluationResult;
    const cohort = buildOfflineExperimentCohort({ results: [result], cases: [evaluationCase] });
    expect(cohort.cases[0]?.measurements.integrity[0]).toMatchObject({ name: "integrity-pass", value: 1 });
    expect(cohort.cases[0]?.input).toEqual(evaluationCase.inputs);
    expect(cohort.cases[0]?.repetition).toEqual({ index: 1, hash: "sha256:repetition-1" });
    expect(JSON.stringify(cohort.cases[0]?.output)).not.toContain("private-reference");
    expect(cohort.identities).toMatchObject({ corpus: "sha256:corpus", agentConfiguration: "sha256:agent" });
  });
});
