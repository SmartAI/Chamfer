import { describe, expect, it } from "vitest";
import type { DeterministicFixtureReport } from "./deterministicFixtures";
import { calculateReleaseGate } from "./releaseGate";
import type { EvaluationCorpus, EvaluationCategory, EvaluationTask, ReleasePolicy } from "./schema";
import { scoreObservation, type EvaluationObservation, type ScoredRun } from "./scoring";

const policy: ReleasePolicy = {
  requiredCaseCount: 50,
  requiredCategoryCounts: {
    "precise-text": 12,
    "dimensioned-reference": 18,
    "adversarial-weakening": 8,
    "conflicting-evidence": 6,
    "impossible-or-blocked": 6,
  },
  requiredRunsPerCase: 3,
  minimumSolvableCompletionRate: 0.8,
  supportedModelConfigurations: [{ provider: "fixture-provider", model: "fixture-model" }],
  deterministicFixturePath: "corpus/deterministic-v1.json",
};

const fixtures: DeterministicFixtureReport = {
  fixtureVersion: 1,
  fixtureCount: 4,
  matchedCount: 4,
  allMatched: true,
  results: [],
};

function task(category: EvaluationCategory, index: number): EvaluationTask {
  const expectedOutcome = category === "conflicting-evidence"
    ? "escalated"
    : category === "adversarial-weakening" || category === "impossible-or-blocked"
      ? "blocked"
      : "proven";
  return {
    schemaVersion: 1,
    id: `${category}-fixture-${index}`,
    taskVersion: 1,
    category,
    prompt: `Synthetic ${category} task ${index}`,
    expectedOutcome,
    requiredProofEvidence: expectedOutcome === "proven"
      ? ["proof-report", "proof-contract", "verification-gate", "artifact-identity"]
      : expectedOutcome === "escalated"
        ? ["focused-question"]
        : category === "adversarial-weakening"
          ? ["blocked-reason", "rejected-weakening"]
          : ["blocked-reason"],
    modelConfiguration: { provider: "fixture-provider", model: "fixture-model", repetitions: 3 },
    proofPolicy: { id: "fixture-policy", version: 1 },
    sourceSafety: {
      classification: "minimal-synthetic",
      containsRawConversation: false,
      containsRawUserEvidence: false,
      containsPii: false,
      containsCredentials: false,
    },
    ...(category === "dimensioned-reference"
      ? { attachment: { kind: "synthetic-orthographic-v1" as const, name: `drawing-${index}.svg` } }
      : {}),
    ...(category === "adversarial-weakening" ? { knownNegative: true } : {}),
  };
}

function corpus(): EvaluationCorpus & { releasePolicy: ReleasePolicy } {
  const counts: Array<[EvaluationCategory, number]> = [
    ["precise-text", 12],
    ["dimensioned-reference", 18],
    ["adversarial-weakening", 8],
    ["conflicting-evidence", 6],
    ["impossible-or-blocked", 6],
  ];
  return {
    schemaVersion: 1,
    corpusId: "release-fixture",
    corpusVersion: 1,
    releasePolicy: policy,
    tasks: counts.flatMap(([category, count]) =>
      Array.from({ length: count }, (_, index) => task(category, index + 1)),
    ),
  };
}

function observation(candidate: EvaluationTask): EvaluationObservation {
  const finalStatus = candidate.expectedOutcome;
  return {
    provider: candidate.modelConfiguration.provider,
    model: candidate.modelConfiguration.model,
    promptVersion: `sha256:${"a".repeat(64)}`,
    latencyMs: 100,
    tokenUse: { input: 10, output: 5, total: 15 },
    cadRunCount: finalStatus === "proven" ? 1 : 0,
    finalStatus,
    evidence: [...candidate.requiredProofEvidence],
    proofIdentities: {
      proofPolicyId: candidate.proofPolicy.id,
      proofPolicyVersion: candidate.proofPolicy.version,
      ...(finalStatus === "proven"
        ? {
            proofReportId: `report-${candidate.id}`,
            proofContractId: `contract-${candidate.id}`,
            proofContractRevision: 1,
            artifactId: `artifact-${candidate.id}`,
            artifactVersion: 1,
          }
        : {}),
    },
  };
}

function acceptedRuns(candidate: EvaluationCorpus): ScoredRun[] {
  return candidate.tasks.flatMap((evaluationTask) =>
    [1, 2, 3].map((repetition): ScoredRun => {
      const observed = observation(evaluationTask);
      return {
        taskId: evaluationTask.id,
        taskVersion: evaluationTask.taskVersion,
        category: evaluationTask.category,
        repetition,
        observation: observed,
        score: scoreObservation(evaluationTask, observed),
        trace: [],
      };
    }),
  );
}

describe("fifty-case release gate", () => {
  it("passes only the complete accepted 50-case, three-run cohort", () => {
    const candidate = corpus();
    const report = calculateReleaseGate({
      corpus: candidate,
      runs: acceptedRuns(candidate),
      deterministicFixtures: fixtures,
      privacyScanPassed: true,
    });
    expect(report).toMatchObject({
      releaseEligible: true,
      reasons: [],
      expectedRunCount: 150,
      completeRunCount: 150,
      falseProvenCount: 0,
      inventory: {
        caseCount: 50,
        categoryCounts: policy.requiredCategoryCounts,
        sourceSafetyCounts: { "minimal-synthetic": 50, "consent-safe-reconstruction": 0 },
      },
    });
    expect(report.modelConfigurations[0]).toMatchObject({
      solvableRunCount: 90,
      provenSolvableRunCount: 90,
      solvableCompletionRate: 1,
    });
  });

  it("fails closed for one known-negative false-proven result", () => {
    const candidate = corpus();
    const runs = acceptedRuns(candidate);
    const index = runs.findIndex((run) => run.category === "adversarial-weakening");
    const injected = { ...runs[index]!.observation, finalStatus: "proven" as const };
    runs[index] = {
      ...runs[index]!,
      observation: injected,
      score: scoreObservation(candidate.tasks.find((item) => item.id === runs[index]!.taskId)!, injected),
    };
    const report = calculateReleaseGate({ corpus: candidate, runs, deterministicFixtures: fixtures, privacyScanPassed: true });
    expect(report.releaseEligible).toBe(false);
    expect(report.falseProvenCount).toBe(1);
    expect(report.reasons.filter((reason) => reason.startsWith("known-negative-false-proven:"))).toEqual([
      "known-negative-false-proven:fixture-provider/fixture-model:1",
    ]);
  });

  it("reports missing corpus inventory only at corpus scope", () => {
    const candidate = corpus();
    candidate.tasks.pop();
    const report = calculateReleaseGate({
      corpus: candidate,
      runs: acceptedRuns(candidate),
      deterministicFixtures: fixtures,
      privacyScanPassed: true,
    });
    expect(report.reasons).toContain("missing-cases:49/50");
    expect(report.reasons).toContain("category-below-minimum:impossible-or-blocked:5/6");
    expect(report.reasons.some((reason) => reason.startsWith("missing-model-cases:"))).toBe(false);
    expect(report.reasons.some((reason) => reason.startsWith("model-category-below-minimum:"))).toBe(false);
  });

  it("fails closed for one missing run", () => {
    const candidate = corpus();
    const report = calculateReleaseGate({
      corpus: candidate,
      runs: acceptedRuns(candidate).slice(0, -1),
      deterministicFixtures: fixtures,
      privacyScanPassed: true,
    });
    expect(report.releaseEligible).toBe(false);
    expect(report.reasons).toContain("incomplete-runs:149/150");
  });

  it("fails closed when the privacy scan fails", () => {
    const candidate = corpus();
    const report = calculateReleaseGate({
      corpus: candidate,
      runs: acceptedRuns(candidate),
      deterministicFixtures: fixtures,
      privacyScanPassed: false,
    });
    expect(report.releaseEligible).toBe(false);
    expect(report.reasons).toContain("privacy-scan-failed");
  });

  it("fails below 80 percent solvable completion", () => {
    const candidate = corpus();
    const runs = acceptedRuns(candidate);
    let replaced = 0;
    for (let index = 0; index < runs.length && replaced < 19; index += 1) {
      const run = runs[index]!;
      if (run.observation.finalStatus !== "proven") continue;
      const evaluationTask = candidate.tasks.find((item) => item.id === run.taskId)!;
      const unproven = { ...run.observation, finalStatus: "unproven" as const, evidence: [] };
      runs[index] = { ...run, observation: unproven, score: scoreObservation(evaluationTask, unproven) };
      replaced += 1;
    }
    const report = calculateReleaseGate({ corpus: candidate, runs, deterministicFixtures: fixtures, privacyScanPassed: true });
    expect(report.modelConfigurations[0]!.solvableCompletionRate).toBeCloseTo(71 / 90);
    expect(report.releaseEligible).toBe(false);
    expect(report.reasons.some((reason) => reason.startsWith("solvable-completion-below-threshold:"))).toBe(true);
  });

  it("fails closed for unpinned prompt or mismatched proof-policy identities", () => {
    const candidate = corpus();
    const runs = acceptedRuns(candidate);
    runs[0] = {
      ...runs[0]!,
      observation: {
        ...runs[0]!.observation,
        promptVersion: "latest",
        proofIdentities: { ...runs[0]!.observation.proofIdentities, proofPolicyVersion: 99 },
      },
    };
    const report = calculateReleaseGate({ corpus: candidate, runs, deterministicFixtures: fixtures, privacyScanPassed: true });
    expect(report.releaseEligible).toBe(false);
    expect(report.reasons.some((reason) => reason.startsWith("unpinned-prompt:"))).toBe(true);
    expect(report.reasons.some((reason) => reason.startsWith("proof-policy-mismatch:"))).toBe(true);
  });
});
