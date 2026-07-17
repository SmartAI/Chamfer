import { describe, expect, it } from "vitest";
import { compareCohorts, isEvaluationResultFilename } from "./comparison";
import { parseEvaluationResult, type EvaluationResult } from "./result";

const hash = `sha256:${"e".repeat(64)}`;

function attempt(input: {
  release: string;
  caseId?: string;
  repetition?: number;
  cost: number;
  expectedMatch: boolean;
  scoreStatus?: "passed" | "failed" | "unavailable";
  violations?: EvaluationResult["integrity"]["violations"];
}): EvaluationResult {
  const caseId = input.caseId ?? "text.precise-box";
  return parseEvaluationResult({
    schemaVersion: 1,
    identities: {
      corpus: { id: "tracer", version: 1, hash },
      case: {
        id: caseId,
        version: 1,
        hash,
        purpose: "Fixture",
        modality: "text",
        complexity: "smoke",
        categories: ["construction"],
        gatingStatus: "release",
      },
      assets: [],
      agentConfiguration: {
        hash: `${hash.slice(0, -1)}${input.release === "candidate" ? "1" : "2"}`,
        productRelease: input.release,
        gitCommit: `${input.release}-commit`,
        dirty: false,
        promptHash: hash,
        skillHash: hash,
        policyHash: hash,
        toolsetHash: hash,
        provider: "anthropic",
        model: "fixture-model",
        inferenceSettingsHash: hash,
      },
      evaluators: [{ id: "verification-gate", version: 1, required: true, hash }],
      rubrics: [],
      runner: { version: 1, hash },
      environment: {
        hash,
        node: "26.4.0",
        browser: "chromium",
        operatingSystem: "darwin",
        architecture: "arm64",
        productBuildHash: hash,
      },
      repetition: { index: input.repetition ?? 1, hash },
    },
    evidenceClass: "proficiency",
    execution: {
      state: "completed",
      startedAt: "2026-07-13T07:00:00.000Z",
      finishedAt: "2026-07-13T07:00:10.000Z",
      durationMs: 10_000,
    },
    outcome: {
      kind: input.expectedMatch ? "completed" : "incomplete",
      expectedMatch: input.expectedMatch,
    },
    evidence: [{ id: "conversation", kind: "conversation", reference: "conversation:fixture" }],
    measurements: {
      cadRuns: 1,
      modelCalls: 2,
      toolCalls: 1,
      toolErrors: 0,
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      providerCost: input.cost,
      modelLatencyMs: 100,
      toolLatencyMs: 50,
      cadLatencyMs: 25,
      compactionLatencyMs: 5,
      persistenceLatencyMs: 10,
      retryDelayMs: 2,
      persistenceFailures: input.expectedMatch ? 0 : 1,
    },
    scores: [{
      id: "verification-gate",
      evaluatorVersion: 1,
      status: input.scoreStatus ?? "passed",
      required: true,
      ...((input.scoreStatus ?? "passed") === "unavailable" ? {} : {
        value: (input.scoreStatus ?? "passed") === "passed" ? 1 : 0,
      }),
      evidenceIds: ["conversation"],
    }],
    proficiency: { included: true },
    integrity: { violations: input.violations ?? [] },
  });
}

const policy = {
  version: 1,
  minimumExpectedOutcomeRate: 1,
  minimumPerCaseReliability: 1,
};

function schedule(...entries: Array<{ caseId?: string; repetition?: number }>) {
  return entries.map((entry) => ({
    caseId: entry.caseId ?? "text.precise-box",
    caseVersion: 1,
    repetition: entry.repetition ?? 1,
  }));
}

describe("release cohort comparison", () => {
  it("selects canonical attempt files without treating cohort metadata as a result", () => {
    expect(isEvaluationResultFilename("text.precise-box-v1-r1.json")).toBe(true);
    expect(isEvaluationResultFilename("image.case-v12-r3.json")).toBe(true);
    expect(isEvaluationResultFilename("offline-cohort.json")).toBe(false);
    expect(isEvaluationResultFilename("cohort-verdict.json")).toBe(false);
    expect(isEvaluationResultFilename("privacy-scan.json")).toBe(false);
  });

  it("passes an accepted candidate with the same complete outcome and lower successful cost", () => {
    const comparison = compareCohorts({
      candidate: [attempt({ release: "candidate", cost: 0.5, expectedMatch: true })],
      control: [attempt({ release: "control", cost: 1, expectedMatch: true })],
      requiredAttempts: schedule({}),
      policy,
    });

    expect(comparison).toMatchObject({ status: "passed", passes: true, decidingLayer: "none" });
    expect(comparison.cases[0]?.classification).toBe("improved");
    expect(comparison.summary).toMatchObject({ candidateProviderCost: 0.5, controlProviderCost: 1 });
    expect(comparison.summary.byModality).toEqual([{
      key: "text", attempts: 1, successful: 1, expectedOutcomeRate: 1, providerCost: 0.5,
      controlAttempts: 1, controlSuccessful: 1, controlExpectedOutcomeRate: 1, controlProviderCost: 1,
      expectedOutcomeRateDelta: 0, providerCostDelta: -0.5,
    }]);
    expect(comparison.summary.byClassification).toEqual([{
      key: "improved", attempts: 1, successful: 1, expectedOutcomeRate: 1, providerCost: 0.5,
      controlAttempts: 1, controlSuccessful: 1, controlExpectedOutcomeRate: 1, controlProviderCost: 1,
      expectedOutcomeRateDelta: 0, providerCostDelta: -0.5,
    }]);
    expect(comparison.cases[0]?.candidate.successfulTotals).toMatchObject({
      modelLatencyMs: 100,
      toolLatencyMs: 50,
      cadLatencyMs: 25,
      compactionLatencyMs: 5,
      persistenceLatencyMs: 10,
      retryDelayMs: 2,
      persistenceFailures: 0,
    });
  });

  it("fails closed when candidate and control both omit a declared attempt", () => {
    const comparison = compareCohorts({
      candidate: [attempt({ release: "candidate", cost: 0.5, expectedMatch: true })],
      control: [attempt({ release: "control", cost: 1, expectedMatch: true })],
      requiredAttempts: [
        { caseId: "text.precise-box", caseVersion: 1, repetition: 1 },
        { caseId: "text.precise-box", caseVersion: 1, repetition: 2 },
      ],
      policy,
    });

    expect(comparison).toMatchObject({ status: "incomplete", passes: false, decidingLayer: "integrity" });
  });

  it("fails closed when the control has an unavailable required score", () => {
    const comparison = compareCohorts({
      candidate: [attempt({ release: "candidate", cost: 0.5, expectedMatch: true })],
      control: [attempt({
        release: "control",
        cost: 1,
        expectedMatch: false,
        scoreStatus: "unavailable",
      })],
      requiredAttempts: schedule({}),
      policy,
    });

    expect(comparison).toMatchObject({ status: "incomplete", passes: false, decidingLayer: "integrity" });
  });

  it("keeps failed-attempt operations out of successful-attempt totals", () => {
    const comparison = compareCohorts({
      candidate: [
        attempt({ release: "candidate", repetition: 1, cost: 0.5, expectedMatch: true }),
        attempt({ release: "candidate", repetition: 2, cost: 2, expectedMatch: false }),
      ],
      control: [
        attempt({ release: "control", repetition: 1, cost: 1, expectedMatch: true }),
        attempt({ release: "control", repetition: 2, cost: 1, expectedMatch: true }),
      ],
      requiredAttempts: schedule({ repetition: 1 }, { repetition: 2 }),
      policy: { ...policy, minimumExpectedOutcomeRate: 0.5, minimumPerCaseReliability: 0.5 },
    });

    expect(comparison.cases[0]?.candidate).toMatchObject({ cost: 2.5, successfulCost: 0.5 });
    expect(comparison.cases[0]?.candidate.successfulTotals).toMatchObject({
      cost: 0.5,
      wallTimeMs: 10_000,
      modelLatencyMs: 100,
      persistenceFailures: 0,
    });
  });

  it("reports a cheaper failed candidate as a proficiency regression", () => {
    const comparison = compareCohorts({
      candidate: [attempt({ release: "candidate", cost: 0.1, expectedMatch: false })],
      control: [attempt({ release: "control", cost: 10, expectedMatch: true })],
      requiredAttempts: schedule({}),
      policy,
    });

    expect(comparison).toMatchObject({ status: "failed", passes: false, decidingLayer: "proficiency" });
    expect(comparison.cases[0]).toMatchObject({ classification: "regressed" });
    expect(comparison.cases[0]?.candidate.cost).toBeLessThan(comparison.cases[0]!.control.cost);
  });

  it("does not let aggregate improvement hide one false-success regression", () => {
    const comparison = compareCohorts({
      candidate: [
        attempt({ release: "candidate", caseId: "case-improved", cost: 1, expectedMatch: true }),
        attempt({
          release: "candidate",
          caseId: "case-unsafe",
          cost: 1,
          expectedMatch: false,
          violations: ["known-negative-success"],
        }),
      ],
      control: [
        attempt({ release: "control", caseId: "case-improved", cost: 5, expectedMatch: false }),
        attempt({ release: "control", caseId: "case-unsafe", cost: 5, expectedMatch: true }),
      ],
      requiredAttempts: schedule({ caseId: "case-improved" }, { caseId: "case-unsafe" }),
      policy,
    });

    expect(comparison).toMatchObject({ status: "failed", passes: false, decidingLayer: "integrity" });
    expect(comparison.cases.find((item) => item.caseId === "case-unsafe")?.classification).toBe("regressed");
  });

  it("marks incompatible evaluator identity as unsupported", () => {
    const control = attempt({ release: "control", cost: 1, expectedMatch: true });
    const incompatible = attempt({ release: "candidate", cost: 1, expectedMatch: true });
    incompatible.identities.evaluators[0]!.hash = `sha256:${"f".repeat(64)}`;

    const comparison = compareCohorts({
      candidate: [incompatible],
      control: [control],
      requiredAttempts: schedule({}),
      policy,
    });

    expect(comparison).toMatchObject({ status: "unsupported", passes: false });
    expect(comparison.warnings.join(" ")).toMatch(/evaluator/i);
  });

  it("marks an incompatible runtime environment as unsupported without comparing product builds", () => {
    const control = attempt({ release: "control", cost: 1, expectedMatch: true });
    const incompatible = attempt({ release: "candidate", cost: 1, expectedMatch: true });
    incompatible.identities.environment.browser = "different-browser";
    incompatible.identities.environment.productBuildHash = `sha256:${"f".repeat(64)}`;

    const comparison = compareCohorts({
      candidate: [incompatible],
      control: [control],
      requiredAttempts: schedule({}),
      policy,
    });

    expect(comparison).toMatchObject({ status: "unsupported", passes: false });
    expect(comparison.warnings.join(" ")).toMatch(/runtime environment/i);
  });
});
