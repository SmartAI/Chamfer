import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildPairedCaseIdentity,
  buildFusionEvaluationPlan,
  evaluateFusionAttempt,
  loadFusionEvaluationCorpus,
  sha256,
  validateFusionEvaluationCorpus,
  type FusionEvaluationAttempt,
  type FusionEvaluationCase,
  type FusionEvaluationIdentity,
} from "./evaluation";

const ROOT = resolve(import.meta.dirname, "../../../..");
const CORPUS = "evaluation/fusion/v1/industrial-recovery.json";

const HASH = "1".repeat(64);
const identity: FusionEvaluationIdentity = {
  product: { release: "0.2.2", gitCommit: "a".repeat(40), dirty: false },
  connector: { version: "1", sha256: HASH },
  agent: { version: "1", sha256: HASH, configurationSha256: HASH },
  toolset: { version: "1", sha256: HASH },
  model: { provider: "pinned", model: "pinned", configurationSha256: HASH },
  inferenceSettingsSha256: HASH,
  prompt: { version: "1", sha256: HASH }, policy: { version: "1", sha256: HASH },
  skills: { version: "1", sha256: HASH }, evaluator: { version: "1", sha256: HASH },
  fusion: { version: "2704.1.23" }, mcp: { name: "MCP Server Adapter", version: "1", protocol: "2025-06-18" },
  corpus: { version: "fusion-industrial-recovery-v1", sha256: HASH },
  runner: { version: "1", sha256: HASH },
  environment: { nodeVersion: "v22", platform: "linux", arch: "x64", browser: "chromium" },
  parentCohortIds: [],
};

function passingAttempt(evaluationCase: FusionEvaluationCase, participant: FusionEvaluationAttempt["participant"], trial: number): FusionEvaluationAttempt {
  return {
    schemaVersion: 1,
    attemptId: `${participant}-${evaluationCase.id}-${trial}`,
    cohortId: `${participant}-cohort`,
    participant,
    executionMode: participant === "chamfer" ? "live" : "ingested",
    caseId: evaluationCase.id,
    caseVersion: evaluationCase.version,
    pairedCaseIdentity: buildPairedCaseIdentity(evaluationCase),
    documentSetupSha256: sha256(evaluationCase.documentSetup),
    trial,
    identity,
    executionState: "finished",
    observedOutcome: evaluationCase.expectedOutcome,
    evidence: evaluationCase.requiredEvidence.map((kind) => ({ kind, id: `${evaluationCase.id}:${kind}` })),
    deterministic: { status: "passed", checks: [{ id: evaluationCase.deterministicChecks[0]!.fixtureId, status: "passed" }] },
    semantic: { status: "passed", blinded: true, rubricId: evaluationCase.semanticRubric.id,
      rubricVersion: evaluationCase.semanticRubric.version },
    ...(evaluationCase.integrityProfile ? { integrity: {
      terminalState: evaluationCase.integrityProfile.expectation.terminalState,
      revisionRelation: evaluationCase.integrityProfile.expectation.requiredRevisionRelation,
      ...(evaluationCase.integrityProfile.faultInjection ? { fault: {
        ...evaluationCase.integrityProfile.faultInjection, leaseHeldAtInjection: true,
      } } : {}),
      blockedAttackVectors: evaluationCase.integrityProfile.attackVectors,
    } } : {}),
    diagnostics: { actionCount: Math.min(1, evaluationCase.interactionBudget.maxActions), modelCalls: 1, elapsedMs: 100 },
    startedAt: "2026-07-14T00:00:00.000Z",
    finishedAt: "2026-07-14T00:00:01.000Z",
  };
}

describe("Fusion industrial and failure-recovery evaluation slice", () => {
  it("loads exactly ten review-ready, release-gating single-part cases", async () => {
    const corpus = await loadFusionEvaluationCorpus(CORPUS, ROOT);

    expect(corpus.version).toBe("fusion-industrial-recovery-v1");
    expect(corpus.cases).toHaveLength(10);
    expect(new Set(corpus.cases.map((evaluationCase) => `${evaluationCase.id}@${evaluationCase.version}`)).size).toBe(10);
    for (const evaluationCase of corpus.cases) {
      expect(evaluationCase.integrityProfile?.review).toEqual({
        status: "pending-human-review", scope: "initial-parametric-single-part",
      });
      expect(evaluationCase.integrityProfile?.expectation.overridesScoring).toBe(true);
      expect(evaluationCase.gatingPolicy).toMatchObject({ releaseGating: true, requireDeterministicPass: true });
    }
  });

  it("covers the industrial feature, material, recovery, and attack contract", async () => {
    const { cases } = await loadFusionEvaluationCorpus(CORPUS, ROOT);
    const tags = new Set(cases.flatMap((evaluationCase) => evaluationCase.integrityProfile?.coverage ?? []));
    for (const tag of [
      "precision-fit", "datum-relative", "counterbore", "rib-or-gusset", "threaded-hole",
      "one-sided-feature", "fillet", "chamfer", "section-evidence",
    ] as const) expect(tags).toContain(tag);

    expect(cases.filter((evaluationCase) => evaluationCase.integrityProfile?.coverage.includes("material-provenance") &&
      evaluationCase.integrityProfile.coverage.includes("separate-appearance"))).toHaveLength(4);
    expect(cases.filter((evaluationCase) => evaluationCase.integrityProfile?.faultInjection?.trigger === "action-lease-held" &&
      ["cancellation", "timeout", "mcp-disconnect"].includes(evaluationCase.integrityProfile.faultInjection.kind))).toHaveLength(3);
    expect(cases.filter((evaluationCase) => evaluationCase.integrityProfile?.faultInjection?.kind === "verification-failure" &&
      evaluationCase.integrityProfile.expectation.terminalState === "prior-revision-restored")).toHaveLength(1);
    expect(cases.filter((evaluationCase) => evaluationCase.integrityProfile?.faultInjection?.kind === "undo-failure" &&
      evaluationCase.integrityProfile.expectation.terminalState === "hard-recovery")).toHaveLength(1);
    expect(cases.filter((evaluationCase) => (evaluationCase.integrityProfile?.attackVectors.length ?? 0) > 0)).toHaveLength(3);
    expect(cases.filter((evaluationCase) => evaluationCase.id.startsWith("FUS-IND-")).every((evaluationCase) =>
      (evaluationCase.deterministicChecks[0]?.effects?.length ?? 0) >= 10)).toBe(true);
  });

  it("rejects incomplete or contradictory integrity profiles", async () => {
    const source = JSON.parse(await readFile(resolve(ROOT, CORPUS), "utf8")) as { cases: Array<Record<string, unknown>> };
    const missingExpectation = structuredClone(source);
    delete (missingExpectation.cases[0]!.integrityProfile as Record<string, unknown>).expectation;
    expect(() => validateFusionEvaluationCorpus(missingExpectation)).toThrow();

    const wrongUndoOutcome = structuredClone(source);
    (wrongUndoOutcome.cases[8]!.integrityProfile as Record<string, unknown>).expectation = {
      overridesScoring: true,
      terminalState: "accepted-revision",
      requiredRevisionRelation: "new-revision",
    };
    expect(() => validateFusionEvaluationCorpus(wrongUndoOutcome)).toThrow(/undo failure/i);
  });

  it("builds a complete runner-owned repeated-trial plan without fabricating attempts", async () => {
    const corpus = await loadFusionEvaluationCorpus(CORPUS, ROOT);
    const plan = buildFusionEvaluationPlan(corpus, 2);

    expect(plan).toMatchObject({ kind: "repeated-trial-plan", requiredTrials: 2 });
    expect(plan.cases).toHaveLength(10);
    expect(plan.cases.every((item) => item.trialNumbers.join(",") === "1,2")).toBe(true);
    expect(plan.cases.filter((item) => item.caseId.startsWith("FUS-IND-")).every((item) => item.deterministicEffectCount >= 10)).toBe(true);
    expect(plan.cases.filter((item) => item.faultInjection).length).toBe(5);
  });

  it("lets an observed integrity mismatch override an otherwise passing attempt", async () => {
    const { cases } = await loadFusionEvaluationCorpus(CORPUS, ROOT);
    const rollbackCase = cases.find((evaluationCase) => evaluationCase.id === "FUS-REC-104")!;
    const attempt = passingAttempt(rollbackCase, "chamfer", 1);
    attempt.integrity = { ...attempt.integrity!, revisionRelation: "new-revision" };

    expect(evaluateFusionAttempt(rollbackCase, attempt)).toMatchObject({
      verdict: "integrity-failed",
      eligibleForProficiency: false,
      failures: ["integrity revision relation is new-revision"],
    });
  });
});
