import { describe, expect, it } from "vitest";
import { renderFusionCohortMarkdown, renderFusionComparisonMarkdown } from "./evaluationArtifacts";

const identity = {
  product: { release: "0.2.1", gitCommit: "a".repeat(40), dirty: false },
  connector: { version: "1", sha256: "1".repeat(64) },
  agent: { version: "1", sha256: "2".repeat(64), configurationSha256: "3".repeat(64) },
  toolset: { version: "1", sha256: "4".repeat(64) },
  model: { provider: "scripted", model: "fake", configurationSha256: "5".repeat(64) },
  inferenceSettingsSha256: "6".repeat(64),
  prompt: { version: "1", sha256: "7".repeat(64) }, policy: { version: "1", sha256: "8".repeat(64) },
  skills: { version: "1", sha256: "9".repeat(64) }, evaluator: { version: "1", sha256: "a".repeat(64) },
  fusion: { version: "1" }, mcp: { name: "mcp", version: "1", protocol: "1" },
  corpus: { version: "1", sha256: "b".repeat(64) }, runner: { version: "1", sha256: "c".repeat(64) },
  environment: { nodeVersion: "v22", platform: "linux", arch: "x64", browser: "chromium" }, parentCohortIds: [],
};

describe("Fusion evaluation artifacts", () => {
  it("reports scripted evidence separately from proficiency", () => {
    const markdown = renderFusionCohortMarkdown({
      cohortId: "scripted-smoke",
      participant: "chamfer",
      executionMode: "scripted",
      corpusVersion: "fusion-tracers-v1",
      corpusSha256: "1".repeat(64),
      identity,
      privacyScan: "passed",
      attempts: [{ caseId: "FUS-TEXT-001", trial: 1, verdict: "passed", eligibleForProficiency: false,
        semanticReviewPending: true, failures: [], executionState: "finished", observedOutcome: "completed",
        evidence: [{ kind: "typed-checks", id: "e1" }],
        deterministic: { status: "passed", checks: [{ id: "typed", status: "passed" }] },
        semantic: { status: "pending", blinded: true, rubricId: "rubric", rubricVersion: "1" },
        diagnostics: { costUsd: 0, inputTokens: 10, outputTokens: 5, latencyMs: 100, actionCount: 1, modelCalls: 1, elapsedMs: 120 } }],
    });
    expect(markdown).toContain("Infrastructure evidence only");
    expect(markdown).toContain("FUS-TEXT-001");
    expect(markdown).not.toContain("proficiency pass");
  });

  it("keeps integrity, proficiency, and efficiency columns visibly separate", () => {
    const markdown = renderFusionComparisonMarkdown({
      schemaVersion: 1,
      verdict: "integrity-failed",
      requiredTrials: 2,
      cases: [{ caseId: "FUS-TEXT-001", pairedCaseIdentity: "2".repeat(64), status: "integrity-failed",
        chamferAttempts: 2, autodeskAttempts: 2, chamferPasses: 2, autodeskPasses: 0,
        efficiencyCompared: false, semanticReviewPending: true }],
    });
    expect(markdown).toContain("Integrity status");
    expect(markdown).toContain("Chamfer proficiency");
    expect(markdown).toContain("Efficiency compared");
    expect(markdown).toContain("no");
  });
});
