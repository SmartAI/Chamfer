import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import {
  buildFusionEvaluationPlan,
  buildPairedCaseIdentity,
  sha256,
  loadFusionEvaluationCorpus,
  validateFusionEvaluationCorpus,
  type FusionEvaluationAttempt,
  type FusionEvaluationCase,
  type FusionEvaluationCorpus,
} from "./evaluation";
import { renderFusionSuperiorityGateMarkdown } from "./evaluationArtifacts";
import {
  buildFusionReviewedScoresIdentity,
  evaluateFusionSuperiorityGate,
  type FusionSuperiorityGateMetadata,
} from "./superiorityGate";

const baseCase: FusionEvaluationCase = {
  schemaVersion: 1,
  id: "FUS-TEXT-001",
  version: 1,
  title: "Release-gate fixture",
  inputs: [{ kind: "text", text: "Create the pinned part." }],
  assets: [],
  documentSetup: { kind: "fresh-parametric-part", designHistory: true, units: "mm", setupVersion: "empty-v1" },
  expectedOutcome: "completed",
  requiredEvidence: ["trusted-inspection", "typed-checks"],
  forbiddenOutcomes: ["wrong-document"],
  deterministicChecks: [{ evaluator: "fusion-typed-effects", version: "1", fixtureId: "fixture" }],
  semanticRubric: { id: "fusion-quality", version: "1", dimensions: ["design-intent", "editability", "visual-quality"] },
  interactionBudget: { maxUserTurns: 1, maxAgentTurns: 10, maxActions: 3, maxElapsedMs: 60_000 },
  gatingPolicy: { id: "fusion-superiority", version: "1", releaseGating: true, requireDeterministicPass: true, requireSemanticReview: true },
};

const cases = Array.from({ length: 30 }, (_, index): FusionEvaluationCase => ({
  ...baseCase,
  id: index === 0 ? "FUS-TEXT-001" : index === 1 ? "FUS-IMAGE-001" : index === 2 ? "FUS-TEXT-002"
    : `FUS-GATE-${String(index + 1).padStart(3, "0")}`,
  title: `Gate case ${index + 1}`,
  deterministicChecks: [{ evaluator: "fusion-typed-effects", version: "1", fixtureId: `fixture-${index + 1}` }],
}));
const corpus: FusionEvaluationCorpus = {
  ...validateFusionEvaluationCorpus({ schemaVersion: 1, version: "fusion-release-v1", cases }),
  purpose: "autodesk-assistant-superiority",
  sourceSlices: [{ path: "evaluation/fusion/v1/test.json", version: "test-v1", sha256: "d".repeat(64) }],
};
const REQUIRED_TRACER_IDS = ["FUS-TEXT-001", "FUS-IMAGE-001", "FUS-TEXT-002"] as const;

const identity = {
  product: { release: "0.2.2", gitCommit: "a".repeat(40), dirty: false },
  connector: { version: "connector-1", sha256: "1".repeat(64) },
  agent: { version: "agent-1", sha256: "2".repeat(64), configurationSha256: "3".repeat(64) },
  toolset: { version: "tools-1", sha256: "4".repeat(64) },
  model: { provider: "provider", model: "assistant-v1", configurationSha256: "5".repeat(64) },
  inferenceSettingsSha256: "6".repeat(64),
  prompt: { version: "prompt-1", sha256: "7".repeat(64) },
  policy: { version: "policy-1", sha256: "8".repeat(64) },
  skills: { version: "skills-1", sha256: "9".repeat(64) },
  evaluator: { version: "evaluator-1", sha256: "b".repeat(64) },
  fusion: { version: "2704.1.23" },
  mcp: { name: "Autodesk Fusion MCP", version: "1.0.0", protocol: "2025-11-25" },
  corpus: { version: corpus.version, sha256: corpus.sha256 },
  runner: { version: "runner-1", sha256: "c".repeat(64) },
  environment: { nodeVersion: "v22.19.0", platform: "linux", arch: "x64", browser: "chromium" },
  parentCohortIds: [],
};

function cohorts(): { chamfer: FusionEvaluationAttempt[]; autodesk: FusionEvaluationAttempt[] } {
  const chamfer: FusionEvaluationAttempt[] = [];
  const autodesk: FusionEvaluationAttempt[] = [];
  let sequence = 0;
  for (const [caseIndex, evaluationCase] of cases.entries()) {
    for (let trial = 1; trial <= 5; trial += 1) {
      for (const participant of ["chamfer", "autodesk-assistant"] as const) {
        const startedAt = new Date(Date.UTC(2026, 6, 15, 0, 0, sequence++)).toISOString();
        const controlFails = participant === "autodesk-assistant" && caseIndex < 12;
        const attempt: FusionEvaluationAttempt = {
          schemaVersion: 1,
          attemptId: `${participant}-${evaluationCase.id}-${trial}`,
          cohortId: participant === "chamfer" ? "chamfer-release" : "autodesk-release",
          participant,
          executionMode: participant === "chamfer" ? "live" : "ingested",
          caseId: evaluationCase.id,
          caseVersion: evaluationCase.version,
          pairedCaseIdentity: buildPairedCaseIdentity(evaluationCase),
          documentSetupSha256: sha256(evaluationCase.documentSetup),
          trial,
          identity: { ...identity, model: { ...identity.model, model: participant === "chamfer" ? "chamfer-agent-v1" : "autodesk-assistant-v1" } },
          executionState: "finished",
          observedOutcome: controlFails ? "blocked" : "completed",
          evidence: evaluationCase.requiredEvidence.map((kind, index) => ({ kind, id: `${participant}-${trial}-${index}` })),
          deterministic: { status: "passed", checks: [{ id: "typed-effects", status: "passed" }] },
          semantic: { status: "passed", blinded: true, rubricId: "fusion-quality", rubricVersion: "1",
            scores: { "design-intent": 3, editability: 3, "visual-quality": 3 } },
          diagnostics: { actionCount: 1, modelCalls: 1, elapsedMs: 1_000, latencyMs: 900 },
          startedAt,
          finishedAt: new Date(Date.parse(startedAt) + 1_000).toISOString(),
        };
        (participant === "chamfer" ? chamfer : autodesk).push(attempt);
      }
    }
  }
  return { chamfer, autodesk };
}

function metadataFor(chamfer: FusionEvaluationAttempt[], autodesk: FusionEvaluationAttempt[]): FusionSuperiorityGateMetadata {
  return {
    comparisonDate: "2026-07-15T01:00:00.000Z",
    reviewerAgreement: {
      humanReviewConfirmed: true,
      reviewCohortId: "blinded-review-1",
      reviewProtocolVersion: "fusion-quality-v1",
      assignmentsSha256: "e".repeat(64),
      reviewedScoresSha256: buildFusionReviewedScoresIdentity([...chamfer, ...autodesk]),
      method: "Krippendorff alpha",
      value: 0.84,
      reviewerCount: 3,
    },
    scope: "parametric single-part Fusion tasks",
    limitations: ["The verdict does not cover assemblies, drawings, or manufacturing workflows."],
  };
}

describe("Autodesk Assistant superiority gate", () => {
  it("loads the pinned 33-case authoritative corpus and plans interleaved paired trials", async () => {
    const releaseCorpus = await loadFusionEvaluationCorpus(
      "evaluation/fusion/v1/release-corpus.json",
      resolve(import.meta.dirname, "../../../.."),
    );
    const plan = buildFusionEvaluationPlan(releaseCorpus, 5);

    expect(releaseCorpus.cases).toHaveLength(33);
    expect(releaseCorpus.cases.map((item) => item.id)).toEqual(expect.arrayContaining([...REQUIRED_TRACER_IDS]));
    expect(plan.schedule).toHaveLength(330);
    expect(plan.schedule.slice(0, 4).map((item) => item.participant)).toEqual([
      "chamfer", "autodesk-assistant", "chamfer", "autodesk-assistant",
    ]);
    expect(plan.schedule.every((item, index) => item.sequence === index + 1)).toBe(true);
  });

  it("authorizes only a complete, interleaved, materially superior paired release cohort", () => {
    const { chamfer, autodesk } = cohorts();
    const result = evaluateFusionSuperiorityGate(corpus, chamfer, autodesk, 5, metadataFor(chamfer, autodesk));

    expect(result.verdict).toBe("claim-authorized");
    expect(result.promotionAllowed).toBe(true);
    expect(result.summary).toMatchObject({
      chamfer: { successes: 150, attempts: 150, passRate: 1 },
      autodesk: { successes: 90, attempts: 150, passRate: 0.6 },
      advantagePercentagePoints: 40,
      blindedQualityNoWorse: true,
    });
    expect(result.summary.pairedConfidence95!.lower).toBeGreaterThan(0);
    expect(result.summary.pairedConfidence95!.method).toContain("paired percentile bootstrap");
    expect(result.schedule).toMatchObject({ interleaved: true, maximumConsecutiveParticipantRuns: 1 });
    expect(result.cases).toHaveLength(30);
    expect(result.scope).toMatchObject({ chamferRelease: "0.2.2", autodeskAssistantVersion: "autodesk-assistant-v1" });
  });

  it("fails closed for a Chamfer integrity failure even when proficiency thresholds pass", () => {
    const { chamfer, autodesk } = cohorts();
    chamfer[0] = { ...chamfer[0]!, deterministic: { status: "failed", checks: [{ id: "integrity", status: "failed" }] } };
    const result = evaluateFusionSuperiorityGate(corpus, chamfer, autodesk, 5, metadataFor(chamfer, autodesk));

    expect(result.verdict).toBe("claim-blocked");
    expect(result.promotionAllowed).toBe(false);
    expect(result.reasons).toContain("Chamfer has one or more integrity failures");
    expect(result.summary.efficiency).toBeUndefined();
    expect(result.summary.pairedConfidence95).toBeNull();
  });

  it("fails closed for incomplete trials, weak advantage, nonpositive confidence, or worse blinded quality", () => {
    const complete = cohorts();
    const incompleteChamfer = complete.chamfer.slice(1);
    const incomplete = evaluateFusionSuperiorityGate(corpus, incompleteChamfer, complete.autodesk, 5,
      metadataFor(incompleteChamfer, complete.autodesk));
    expect(incomplete.reasons).toContain("Every case requires exactly 5 complete trials per participant");
    expect(incomplete.cases[0]).toMatchObject({ chamferAttempts: 4, autodeskAttempts: 5 });
    expect(incomplete.summary).toMatchObject({ advantagePercentagePoints: null, pairedConfidence95: null });

    const weak = cohorts();
    for (const attempt of weak.autodesk) attempt.observedOutcome = "completed";
    expect(evaluateFusionSuperiorityGate(corpus, weak.chamfer, weak.autodesk, 5, metadataFor(weak.chamfer, weak.autodesk)).reasons)
      .toContain("Chamfer full-task pass advantage is below 20 percentage points");

    const worse = cohorts();
    for (const attempt of worse.chamfer) attempt.semantic.scores = { "design-intent": 2, editability: 2, "visual-quality": 2 };
    expect(evaluateFusionSuperiorityGate(corpus, worse.chamfer, worse.autodesk, 5, metadataFor(worse.chamfer, worse.autodesk)).reasons)
      .toContain("Blinded review finds Chamfer worse on one or more quality dimensions");

    const drifted = cohorts();
    for (const [index, attempt] of drifted.autodesk.entries()) drifted.autodesk[index] = { ...attempt,
      identity: { ...attempt.identity, environment: { ...attempt.identity.environment, platform: "darwin" } } };
    expect(evaluateFusionSuperiorityGate(corpus, drifted.chamfer, drifted.autodesk, 5, metadataFor(drifted.chamfer, drifted.autodesk)).reasons)
      .toContain("Candidate and control trials require equivalent execution environments");

    const mismatched = cohorts();
    mismatched.autodesk[0] = { ...mismatched.autodesk[0]!, pairedCaseIdentity: "0".repeat(64) };
    expect(evaluateFusionSuperiorityGate(corpus, mismatched.chamfer, mismatched.autodesk, 5,
      metadataFor(mismatched.chamfer, mismatched.autodesk))).toMatchObject({
      verdict: "claim-blocked",
      promotionAllowed: false,
    });

    const notPaired = cohorts();
    [notPaired.autodesk[0]!.startedAt, notPaired.autodesk[1]!.startedAt] =
      [notPaired.autodesk[1]!.startedAt, notPaired.autodesk[0]!.startedAt];
    expect(evaluateFusionSuperiorityGate(corpus, notPaired.chamfer, notPaired.autodesk, 5,
      metadataFor(notPaired.chamfer, notPaired.autodesk)).reasons)
      .toContain("Candidate and control trials are not interleaved");

    const malformedMetadata = cohorts();
    expect(evaluateFusionSuperiorityGate(corpus, malformedMetadata.chamfer, malformedMetadata.autodesk, 5, {})).toMatchObject({
      verdict: "claim-blocked",
      summary: { pairedConfidence95: null, reviewerAgreement: null },
      reasons: expect.arrayContaining(["Superiority-gate metadata is malformed or incomplete"]),
    });

    const unlinkedReview = cohorts();
    const reviewMetadata = metadataFor(unlinkedReview.chamfer, unlinkedReview.autodesk);
    reviewMetadata.reviewerAgreement.reviewedScoresSha256 = "0".repeat(64);
    expect(evaluateFusionSuperiorityGate(corpus, unlinkedReview.chamfer, unlinkedReview.autodesk, 5, reviewMetadata).reasons)
      .toContain("Blinded human-review evidence does not match the scored attempt cohort");
  });

  it("renders a dated, scoped report with raw outcomes, failure classes, agreement, versions, and limitations", () => {
    const { chamfer, autodesk } = cohorts();
    const markdown = renderFusionSuperiorityGateMarkdown(
      evaluateFusionSuperiorityGate(corpus, chamfer, autodesk, 5, metadataFor(chamfer, autodesk)),
    );

    for (const text of [
      "CLAIM AUTHORIZED", "2026-07-15", "FUS-TEXT-001", "150/150", "90/150",
      "Krippendorff alpha", "autodesk-assistant-v1", "parametric single-part Fusion tasks",
      "does not cover assemblies", "Failure classes", "Confidence method", "Efficiency among paired successful outcomes",
    ]) expect(markdown).toContain(text);
  });
});
