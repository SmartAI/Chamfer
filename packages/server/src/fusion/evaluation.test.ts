import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { FUS_MM_COMPLETION_FIXTURES } from "@chamfer/fusion-fixtures";
import type { FusionEngineeringSnapshotDto } from "@chamfer/shared";
import {
  FusionEvaluationCaseSchema,
  FusionEvaluationAttemptSchema,
  assertFusionEvaluationPrivacySafe,
  buildPairedCaseIdentity,
  compareFusionCohorts,
  evaluateFusionAttempt,
  evaluateFusionPreservation,
  isUsableFusionAttemptArtifact,
  loadFusionEvaluationCorpus,
  matchesFusionResponseCriteria,
  sha256,
  validateFusionEvaluationCorpus,
  type FusionEvaluationAttempt,
  type FusionEvaluationCase,
} from "./evaluation";

const identity = {
  product: { release: "0.2.1", gitCommit: "a".repeat(40), dirty: false },
  connector: { version: "connector-1", sha256: "1".repeat(64) },
  agent: { version: "agent-1", sha256: "2".repeat(64), configurationSha256: "a".repeat(64) },
  toolset: { version: "tools-1", sha256: "b".repeat(64) },
  model: { provider: "openai", model: "gpt-5", configurationSha256: "3".repeat(64) },
  inferenceSettingsSha256: "c".repeat(64),
  prompt: { version: "prompt-1", sha256: "4".repeat(64) },
  policy: { version: "policy-1", sha256: "5".repeat(64) },
  skills: { version: "skills-1", sha256: "6".repeat(64) },
  evaluator: { version: "evaluator-1", sha256: "d".repeat(64) },
  fusion: { version: "2704.1.23" },
  mcp: { name: "MCP Server Adapter", version: "1.0.0", protocol: "2025-06-18" },
  corpus: { version: "fusion-tracers-v1", sha256: "7".repeat(64) },
  runner: { version: "fusion-browser-runner-v1", sha256: "8".repeat(64) },
  environment: { nodeVersion: "v22.19.0", platform: "linux", arch: "x64", browser: "playwright-chromium" },
  parentCohortIds: [],
};

const evaluationCase: FusionEvaluationCase = {
  schemaVersion: 1,
  id: "FUS-TEXT-001",
  version: 1,
  title: "Blue aluminum plate",
  inputs: [{ kind: "text", text: "Create the plate." }],
  assets: [],
  documentSetup: { kind: "fresh-parametric-part", designHistory: true, units: "mm", setupVersion: "fusion-empty-part-v1" },
  expectedOutcome: "completed",
  requiredEvidence: ["trusted-inspection", "action-ledger", "typed-checks", "native-undo"],
  forbiddenOutcomes: ["wrong-document", "unsupported-verification", "requirement-weakening"],
  deterministicChecks: [{ evaluator: "fusion-typed-effects", version: "1", fixtureId: "FUS-TEXT-001" }],
  semanticRubric: { id: "fusion-part-quality", version: "1", dimensions: ["design-intent", "editability", "visual-quality"] },
  interactionBudget: { maxUserTurns: 1, maxAgentTurns: 20, maxActions: 6, maxElapsedMs: 600_000 },
  gatingPolicy: { id: "fusion-superiority", version: "1", releaseGating: true, requireDeterministicPass: true, requireSemanticReview: true },
};

function attempt(overrides: Partial<FusionEvaluationAttempt> = {}): FusionEvaluationAttempt {
  return {
    schemaVersion: 1,
    attemptId: "attempt-1",
    cohortId: "cohort-chamfer",
    participant: "chamfer",
    executionMode: "live",
    caseId: evaluationCase.id,
    caseVersion: evaluationCase.version,
    pairedCaseIdentity: buildPairedCaseIdentity(evaluationCase),
    documentSetupSha256: sha256(evaluationCase.documentSetup),
    trial: 1,
    identity,
    executionState: "finished",
    observedOutcome: "completed",
    evidence: evaluationCase.requiredEvidence.map((kind, index) => ({ kind, id: `evidence-${index}` })),
    deterministic: { status: "passed", checks: [{ id: "typed-effects", status: "passed" }] },
    semantic: { status: "passed", blinded: true, rubricId: "fusion-part-quality", rubricVersion: "1",
      scores: { "design-intent": 3, editability: 3, "visual-quality": 3 }, rationale: "Blinded reviewer passed the result." },
    diagnostics: { costUsd: 1, inputTokens: 100, outputTokens: 20, latencyMs: 5000, actionCount: 1, modelCalls: 1, elapsedMs: 6000 },
    startedAt: "2026-07-14T00:00:00.000Z",
    finishedAt: "2026-07-14T00:00:06.000Z",
    ...overrides,
  };
}

describe("Fusion evaluation contract", () => {
  it("declares every requested input mode without relaxing a pinned case", () => {
    const parsed = FusionEvaluationCaseSchema.parse({
      ...evaluationCase,
      inputs: [
        { kind: "text", text: "Create a bracket." },
        { kind: "image", assetId: "drawing" },
        { kind: "turn", text: "Change the hole spacing." },
        { kind: "manual-edit", operation: "set-parameter", fixture: "width=35 mm" },
        { kind: "ownership-transfer", fixture: "transfer from fixture owner" },
      ],
      assets: [{ id: "drawing", path: ".scratch/fusion-connector/fixtures/FUS-IMAGE-001-reference.png", mimeType: "image/png", sha256: "9".repeat(64) }],
      expectedOutcome: "escalated",
    });
    expect(parsed.inputs.map((input) => input.kind)).toEqual(["text", "image", "turn", "manual-edit", "ownership-transfer"]);
    expect(() => FusionEvaluationCaseSchema.parse({ ...evaluationCase, inputs: [], deterministicChecks: [] })).toThrow();
  });

  it("keeps deterministic integrity authoritative over completion and efficiency", () => {
    const cheapFalseSuccess = attempt({
      deterministic: { status: "failed", checks: [{ id: "wrong-document", status: "failed" }] },
      diagnostics: { costUsd: 0.01, inputTokens: 1, outputTokens: 1, latencyMs: 1, actionCount: 1, elapsedMs: 1 },
    });
    expect(evaluateFusionAttempt(evaluationCase, cheapFalseSuccess)).toMatchObject({
      verdict: "integrity-failed",
      eligibleForProficiency: false,
    });
  });

  it("fails closed on required semantic review and interaction-budget gaps", () => {
    const pending = attempt({
      semantic: { status: "pending", blinded: true, rubricId: "fusion-part-quality", rubricVersion: "1" },
    });
    expect(evaluateFusionAttempt(evaluationCase, pending)).toMatchObject({
      verdict: "incomplete", eligibleForProficiency: false, semanticReviewPending: true,
    });
    expect(isUsableFusionAttemptArtifact(evaluateFusionAttempt(evaluationCase, pending))).toBe(true);
    expect(compareFusionCohorts([evaluationCase], [pending], [attempt({
      attemptId: "autodesk-pending", cohortId: "autodesk", participant: "autodesk-assistant",
      semantic: { status: "pending", blinded: true, rubricId: "fusion-part-quality", rubricVersion: "1" },
    })], 1)).toMatchObject({ verdict: "incomplete", cases: [{ status: "incomplete", semanticReviewPending: true }] });
    expect(evaluateFusionAttempt(evaluationCase, attempt({ diagnostics: {
      actionCount: 1, modelCalls: evaluationCase.interactionBudget.maxAgentTurns + 1, elapsedMs: 100,
    } }))).toMatchObject({ verdict: "incomplete", failures: ["agent-turn budget exceeded"] });
    expect(evaluateFusionAttempt(evaluationCase, attempt({ diagnostics: { actionCount: 1, elapsedMs: 100 } })))
      .toMatchObject({ verdict: "incomplete", failures: ["agent-turn count is unavailable"] });
    expect(isUsableFusionAttemptArtifact(evaluateFusionAttempt(evaluationCase,
      attempt({ diagnostics: { actionCount: 1, elapsedMs: 100 } })))).toBe(false);
  });

  it("classifies completion, escalation, blocking, false success, and runner failures", () => {
    for (const outcome of ["completed", "escalated", "blocked"] as const) {
      const expected = { ...evaluationCase, expectedOutcome: outcome };
      expect(evaluateFusionAttempt(expected, attempt({
        observedOutcome: outcome,
        pairedCaseIdentity: buildPairedCaseIdentity(expected),
        documentSetupSha256: sha256(expected.documentSetup),
      })).verdict).toBe("passed");
    }
    expect(evaluateFusionAttempt(evaluationCase, attempt({
      deterministic: { status: "failed", checks: [{ id: "known-negative-false-success", status: "failed" }] },
    })).verdict).toBe("integrity-failed");
    for (const executionState of ["infrastructure-failure", "interrupted"] as const) {
      expect(evaluateFusionAttempt(evaluationCase, attempt({ executionState }))).toMatchObject({ verdict: "incomplete" });
    }
    expect(evaluateFusionAttempt(evaluationCase, attempt({ executionMode: "scripted",
      semantic: { status: "pending", blinded: true, rubricId: "fusion-part-quality", rubricVersion: "1" } })))
      .toMatchObject({ verdict: "passed", eligibleForProficiency: false, semanticReviewPending: true });
  });

  it("requires complete paired cohorts and never lets a cheaper failure beat a pass", () => {
    const chamfer = [attempt(), attempt({ attemptId: "attempt-2", trial: 2 })];
    const incomplete = compareFusionCohorts([evaluationCase], chamfer, [attempt({
      attemptId: "autodesk-1", cohortId: "cohort-autodesk", participant: "autodesk-assistant",
    })], 2);
    expect(incomplete.verdict).toBe("incomplete");
    expect(incomplete.cases[0]).toMatchObject({ status: "incomplete", chamferAttempts: 2, autodeskAttempts: 1 });

    const autodesk = [
      attempt({ attemptId: "autodesk-1", cohortId: "cohort-autodesk", participant: "autodesk-assistant",
        deterministic: { status: "failed", checks: [{ id: "geometry", status: "failed" }] },
        diagnostics: { costUsd: 0.01, inputTokens: 1, outputTokens: 1, latencyMs: 1, actionCount: 1, elapsedMs: 1 } }),
      attempt({ attemptId: "autodesk-2", cohortId: "cohort-autodesk", participant: "autodesk-assistant", trial: 2,
        deterministic: { status: "failed", checks: [{ id: "geometry", status: "failed" }] } }),
    ];
    const comparison = compareFusionCohorts([evaluationCase], chamfer, autodesk, 2);
    expect(comparison.cases[0]).toMatchObject({ status: "integrity-failed", chamferPasses: 2, autodeskPasses: 0 });
    expect(comparison.cases[0]?.efficiencyCompared).toBe(false);
  });

  it("rejects unpinned, mismatched, and duplicate comparison attempts", () => {
    expect(() => FusionEvaluationAttemptSchema.parse({ ...attempt(), identity: { ...identity, prompt: { version: "", sha256: "bad" } } })).toThrow();
    expect(() => compareFusionCohorts([evaluationCase], [attempt()], [attempt({
      attemptId: "autodesk-1", participant: "autodesk-assistant", pairedCaseIdentity: "0".repeat(64),
    })], 1)).toThrow(/paired case identity/i);
    expect(() => compareFusionCohorts([evaluationCase], [attempt(), attempt()], [], 2)).toThrow(/duplicate attempt/i);
    expect(() => compareFusionCohorts([evaluationCase], [attempt({ executionMode: "scripted" })], [attempt({
      attemptId: "autodesk-1", participant: "autodesk-assistant", executionMode: "ingested",
    })], 1)).toThrow(/scripted/i);
    expect(() => compareFusionCohorts([evaluationCase], [attempt(), attempt({
      attemptId: "attempt-2", trial: 2, identity: { ...identity, prompt: { version: "prompt-2", sha256: "9".repeat(64) } },
    })], [], 2)).toThrow(/one pinned identity/i);
    expect(() => compareFusionCohorts([evaluationCase], [attempt()], [attempt({
      attemptId: "autodesk-incompatible", cohortId: "autodesk", participant: "autodesk-assistant",
      identity: { ...identity, evaluator: { version: "other", sha256: "e".repeat(64) } },
    })], 1)).toThrow(/evaluator identities/i);
  });

  it("accepts the three pinned tracer cases as one comparison corpus", () => {
    const cases = ["FUS-TEXT-001", "FUS-IMAGE-001", "FUS-TEXT-002"].map((id, index) => ({
      ...evaluationCase, id, version: 1, title: id,
      inputs: index === 1 ? [{ kind: "text" as const, text: "Use the drawing." }, { kind: "image" as const, assetId: "drawing" }] : evaluationCase.inputs,
      assets: index === 1 ? [{ id: "drawing", path: ".scratch/fusion-connector/fixtures/FUS-IMAGE-001-reference.png", mimeType: "image/png" as const, sha256: "9".repeat(64) }] : [],
      deterministicChecks: [{ evaluator: "fusion-typed-effects" as const, version: "1", fixtureId: id }],
    }));
    expect(validateFusionEvaluationCorpus({ schemaVersion: 1, version: "fusion-tracers-v1", cases }).cases).toHaveLength(3);
  });

  it("loads the committed tracer corpus only when every pinned asset matches", async () => {
    const corpus = await loadFusionEvaluationCorpus("evaluation/fusion/v1/corpus.json", resolve(import.meta.dirname, "../../../.."));
    expect(corpus.cases.map((item) => item.id)).toEqual(["FUS-TEXT-001", "FUS-IMAGE-001", "FUS-TEXT-002"]);
    expect(corpus.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("loads the ten-case multimodal and manual-revision slice with its required coverage", async () => {
    const corpus = await loadFusionEvaluationCorpus(
      "evaluation/fusion/v1/multimodal-manual.json",
      resolve(import.meta.dirname, "../../../.."),
    );

    expect(corpus.version).toBe("fusion-multimodal-manual-v1");
    expect(corpus.cases).toHaveLength(10);
    expect(new Set(corpus.cases.map((item) => item.id)).size).toBe(10);
    expect(corpus.cases.every((item) => item.inputs.some((input) => input.kind === "image"))).toBe(true);
    expect(corpus.cases.filter((item) => item.inputs.some((input) => input.kind === "turn"))).toHaveLength(8);
    expect(corpus.cases.filter((item) => item.inputs.some((input) => input.kind === "manual-edit"))).toHaveLength(3);
    expect(corpus.cases.filter((item) => item.inputs.some((input) => input.kind === "ownership-transfer"))).toHaveLength(1);
    expect(corpus.cases.filter((item) => item.forbiddenOutcomes.includes("revision-local-reference"))).toHaveLength(2);
    expect(corpus.cases.filter((item) => item.expectedOutcome === "escalated").length).toBeGreaterThanOrEqual(2);
    expect(FUS_MM_COMPLETION_FIXTURES.map((fixture) => fixture.id)).toEqual(
      corpus.cases.filter((item) => item.expectedOutcome === "completed").map((item) => item.id),
    );
    expect(corpus.cases.filter((item) => item.requiredEvidence.includes("registered-views")).map((item) => item.id))
      .toEqual(["FUS-MM-101", "FUS-MM-102", "FUS-MM-110"]);
    expect(corpus.cases.filter((item) => item.requiredEvidence.includes("registered-views"))
      .every((item) => item.viewRegistrations?.every((registration) => registration.sharedSpecificationLinks.length > 0)))
      .toBe(true);
    expect(corpus.cases.filter((item) => item.expectedOutcome === "escalated").map((item) => item.focusedQuestion?.requiredTerms))
      .toEqual([["thickness", "rear"], ["left", "right"], ["front", "rear"]]);

    for (const evaluationCase of corpus.cases) {
      expect(evaluationCase.assets.some((asset) => asset.mimeType.startsWith("image/"))).toBe(true);
      expect(evaluationCase.requiredEvidence).toEqual(expect.arrayContaining([
        "source-linked-specifications", "trusted-inspection", "visual-evidence",
      ]));
      if (evaluationCase.expectedOutcome === "completed") {
        expect(evaluationCase.requiredEvidence).toContain("visual-verification");
      }
      expect(evaluationCase.forbiddenOutcomes).toEqual(expect.arrayContaining([
        "wrong-orientation", "wrong-face-feature", "weakened-dimension", "stale-evidence",
        "destructive-rebuild", "ambiguous-entity-use", "displaced-camera",
      ]));
      expect(evaluationCase.semanticRubric.dimensions).toEqual([
        "design-intent", "editability", "visual-quality",
      ]);
    }
    expect(corpus.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("loads exactly ten reviewed foundational cases with stable task-derived coverage", async () => {
    const corpus = await loadFusionEvaluationCorpus(
      "evaluation/fusion/v1/foundational.json",
      resolve(import.meta.dirname, "../../../.."),
    );

    expect(corpus.version).toBe("fusion-foundational-v1");
    expect(corpus.cases.map((item) => item.id)).toEqual(
      Array.from({ length: 10 }, (_, index) => `FUS-FOUND-${String(index + 1).padStart(3, "0")}`),
    );
    expect(new Set(corpus.cases.map((item) => `${item.id}@${item.version}`))).toHaveLength(10);
    expect(corpus.cases.every((item) => item.review?.privacySafe && item.review?.sequenceNeutral)).toBe(true);
    expect(corpus.cases.every((item) => (item.difficultyBasis?.length ?? 0) > 0)).toBe(true);
    expect(corpus.cases.every((item) => (item.typedEffects?.length ?? 0) > 0)).toBe(true);
    expect(corpus.cases.every((item) => item.dimensionalRequirements?.every(
      (requirement) => requirement.nominalMm >= 0 && requirement.toleranceMm > 0,
    ))).toBe(true);
    expect(corpus.cases.every((item) => item.assets.length === 1 && item.assets[0]?.id === "fixture-contract")).toBe(true);
    expect(() => validateFusionEvaluationCorpus({
      schemaVersion: corpus.schemaVersion,
      version: corpus.version,
      slice: corpus.slice,
      cases: corpus.cases.slice(0, 9),
    })).toThrow(/exactly ten/i);
    expect(() => validateFusionEvaluationCorpus({
      schemaVersion: corpus.schemaVersion,
      version: corpus.version,
      slice: corpus.slice,
      cases: corpus.cases.map((item, index) => index === 0 ? { ...item, review: undefined } : item),
    })).toThrow(/review metadata/i);
  });

  it("covers foundational features, revisions, materials, escalation, and honest blocking", async () => {
    const { cases } = await loadFusionEvaluationCorpus(
      "evaluation/fusion/v1/foundational.json",
      resolve(import.meta.dirname, "../../../.."),
    );
    const featureKinds = new Set(cases.flatMap((item) => item.nativeFeatureIntent ?? []));

    expect([...featureKinds]).toEqual(expect.arrayContaining([
      "constrained-sketch", "extrusion", "revolve", "hole", "counterbore", "pocket",
      "pattern", "parameter", "fillet", "chamfer", "one-solid",
    ]));
    expect(cases.filter((item) => item.inputs.some((input) => input.kind === "turn"))).toHaveLength(3);
    expect(cases.filter((item) => item.materialAssignment && item.appearanceAssignment).length).toBeGreaterThanOrEqual(3);
    expect(new Set(cases.flatMap((item) => item.materialAssignment?.family ?? []))).toEqual(new Set(["metal", "plastic"]));
    expect(cases.filter((item) => item.expectedOutcome === "escalated")).toHaveLength(1);
    expect(cases.filter((item) => item.expectedOutcome === "blocked")).toHaveLength(1);
    expect(cases.find((item) => item.id === "FUS-FOUND-002")?.typedEffects).toContainEqual(
      expect.objectContaining({ kind: "feature", featureType: "RectangularPatternFeature", name: "Mounting Hole Pattern" }),
    );
    expect(cases.filter((item) => item.expectedOutcome === "completed").every((item) => item.typedEffects?.some(
      (effect) => effect.kind === "fully-constrained-sketches" && effect.requireAll,
    ))).toBe(true);
    expect(cases.find((item) => item.id === "FUS-FOUND-004")?.typedEffects).toContainEqual(
      { kind: "angle-parameter", name: "v_groove_angle", expectedDegrees: 40, toleranceDegrees: 0.2 },
    );
    expect(cases.find((item) => item.id === "FUS-FOUND-006")?.typedEffects).toContainEqual(
      { kind: "circular-pattern", name: "Grip Groove Pattern", expectedOccurrences: 12 },
    );
  });

  it("measures targeted preservation and semantic non-completion criteria", async () => {
    const { cases } = await loadFusionEvaluationCorpus(
      "evaluation/fusion/v1/foundational.json",
      resolve(import.meta.dirname, "../../../.."),
    );
    const revisedFlange = cases.find((item) => item.id === "FUS-FOUND-002")!;
    const parameterNames = ["flange_length", "flange_width", "mount_hole_diameter", "counterbore_depth", "center_opening_diameter"];
    const featureNames = ["Mounting Hole Pattern", "Corner Fillets", "Perimeter Chamfers"];
    const snapshot = (openingDiameter: number, changedFeatureId = false): FusionEngineeringSnapshotDto => ({
      designIntent: { designType: "parametric", rootComponent: "Flange", timelineMarker: 4 },
      units: { distance: "mm", angle: "deg", internalDistance: "cm" },
      parameters: parameterNames.map((name, index) => ({
        id: `parameter-${index}`, name,
        expression: `${name === "center_opening_diameter" ? openingDiameter : index + 1} mm`,
        valueMm: name === "center_opening_diameter" ? openingDiameter : index + 1,
        unit: "mm",
      })),
      sketches: [],
      features: featureNames.map((name, index) => ({
        id: changedFeatureId && index === 0 ? "rebuilt-pattern" : `feature-${index}`,
        name,
        type: index === 0 ? "RectangularPatternFeature" : index === 1 ? "FilletFeature" : "ChamferFeature",
        timelineIndex: index + 1,
        suppressed: false,
      })),
      bodies: [],
      materials: [],
      entities: [],
    });
    const before = { afterInput: 1, revision: "rev-1", snapshot: snapshot(40) };

    expect(evaluateFusionPreservation(revisedFlange, [before,
      { afterInput: 2, revision: "rev-2", snapshot: snapshot(42) }])).toEqual([
      expect.objectContaining({ id: "targeted-preservation:2", status: "passed" }),
    ]);
    expect(evaluateFusionPreservation(revisedFlange, [before,
      { afterInput: 2, revision: "rev-2", snapshot: snapshot(42, true) }])).toEqual([
      expect.objectContaining({ id: "targeted-preservation:2", status: "failed" }),
    ]);

    const escalation = cases.find((item) => item.id === "FUS-FOUND-007")!;
    const blocked = cases.find((item) => item.id === "FUS-FOUND-008")!;
    expect(matchesFusionResponseCriteria(escalation, "Could you clarify?")).toBe(false);
    expect(matchesFusionResponseCriteria(escalation,
      "Should the upright orientation follow the 80 mm direction or the 50 mm direction?")).toBe(true);
    expect(matchesFusionResponseCriteria(blocked, "I cannot complete that.")).toBe(false);
    expect(matchesFusionResponseCriteria(blocked,
      "Sheet metal is unsupported in this connector; the next step is to use a supported Fusion workflow.")).toBe(true);
  });

  it("accepts repeated-trial artifacts for every foundational case", async () => {
    const { cases } = await loadFusionEvaluationCorpus(
      "evaluation/fusion/v1/foundational.json",
      resolve(import.meta.dirname, "../../../.."),
    );
    const completedEvidence = ["trusted-inspection", "action-ledger", "typed-checks", "native-undo", "visual-evidence"] as const;
    const expectedContracts = [
      { id: "FUS-FOUND-001", outcome: "completed", evidence: completedEvidence, actionCount: 1 },
      { id: "FUS-FOUND-002", outcome: "completed", evidence: completedEvidence, actionCount: 1 },
      { id: "FUS-FOUND-003", outcome: "completed", evidence: completedEvidence, actionCount: 1 },
      { id: "FUS-FOUND-004", outcome: "completed", evidence: completedEvidence, actionCount: 1 },
      { id: "FUS-FOUND-005", outcome: "completed", evidence: completedEvidence, actionCount: 1 },
      { id: "FUS-FOUND-006", outcome: "completed", evidence: completedEvidence, actionCount: 1 },
      { id: "FUS-FOUND-007", outcome: "escalated", evidence: ["trusted-inspection", "typed-checks", "focused-question"], actionCount: 0 },
      { id: "FUS-FOUND-008", outcome: "blocked", evidence: ["trusted-inspection", "typed-checks", "blocking-diagnosis"], actionCount: 0 },
      { id: "FUS-FOUND-009", outcome: "completed", evidence: completedEvidence, actionCount: 1 },
      { id: "FUS-FOUND-010", outcome: "completed", evidence: completedEvidence, actionCount: 1 },
    ] as const;

    for (const expected of expectedContracts) {
      const evaluationCase = cases.find((candidate) => candidate.id === expected.id)!;
      for (const trial of [1, 2]) {
        const result = evaluateFusionAttempt(evaluationCase, attempt({
          attemptId: `${evaluationCase.id}-${trial}`,
          caseId: evaluationCase.id,
          caseVersion: evaluationCase.version,
          pairedCaseIdentity: buildPairedCaseIdentity(evaluationCase),
          documentSetupSha256: sha256(evaluationCase.documentSetup),
          trial,
          observedOutcome: expected.outcome,
          evidence: expected.evidence.map((kind, index) => ({ kind, id: `evidence-${index}` })),
          diagnostics: { costUsd: 1, inputTokens: 100, outputTokens: 20, latencyMs: 5000,
            actionCount: expected.actionCount, modelCalls: 1, elapsedMs: 6000 },
          semantic: {
            status: "passed",
            blinded: true,
            rubricId: evaluationCase.semanticRubric.id,
            rubricVersion: evaluationCase.semanticRubric.version,
            scores: { "design-intent": 3, editability: 3, "visual-quality": 3 },
          },
        }));
        expect(result.verdict, evaluationCase.id).toBe("passed");
      }
    }

    const revisedFlange = cases.find((candidate) => candidate.id === "FUS-FOUND-002")!;
    expect(evaluateFusionAttempt(revisedFlange, attempt({
      attemptId: "FUS-FOUND-002-missing-final-evidence",
      caseId: "FUS-FOUND-002",
      caseVersion: 1,
      pairedCaseIdentity: buildPairedCaseIdentity(revisedFlange),
      documentSetupSha256: sha256(revisedFlange.documentSetup),
      trial: 2,
      observedOutcome: "completed",
      evidence: [
        { kind: "trusted-inspection", id: "inspection" },
        { kind: "action-ledger", id: "ledger" },
        { kind: "native-undo", id: "undo" },
        { kind: "visual-evidence", id: "views" },
      ],
    }))).toMatchObject({ verdict: "incomplete", failures: ["missing evidence: typed-checks"] });
  });

  it("rejects secrets, absolute local paths, and private URLs from artifacts", () => {
    for (const unsafe of ["sk-secret-token-123456", "/home/example/private.step", "https://private.example.test/evidence"]) {
      expect(() => assertFusionEvaluationPrivacySafe({ detail: unsafe })).toThrow(/privacy/i);
    }
    expect(() => assertFusionEvaluationPrivacySafe({ path: ".scratch/fixture.png", endpoint: "http://127.0.0.1:8997/mcp" })).not.toThrow();
  });
});
