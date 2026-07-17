import type { DeterministicFixtureReport } from "./deterministicFixtures";
import type { EvaluationCorpus, EvaluationCategory, ReleasePolicy } from "./schema";
import type { ScoredRun } from "./scoring";

const CATEGORIES: EvaluationCategory[] = [
  "precise-text",
  "dimensioned-reference",
  "adversarial-weakening",
  "conflicting-evidence",
  "impossible-or-blocked",
];

export interface ReleaseGateInput {
  corpus: EvaluationCorpus & { releasePolicy: ReleasePolicy };
  runs: readonly ScoredRun[];
  deterministicFixtures: DeterministicFixtureReport;
  privacyScanPassed: boolean;
}

export interface ModelReleaseResult {
  provider: string;
  model: string;
  expectedRunCount: number;
  observedRunCount: number;
  solvableRunCount: number;
  provenSolvableRunCount: number;
  solvableCompletionRate: number;
  falseProvenCount: number;
}

export interface ReleaseGateReport {
  releaseEligible: boolean;
  reasons: string[];
  inventory: {
    caseCount: number;
    categoryCounts: Record<EvaluationCategory, number>;
    sourceSafetyCounts: Record<"minimal-synthetic" | "consent-safe-reconstruction", number>;
  };
  expectedRunCount: number;
  observedRunCount: number;
  completeRunCount: number;
  falseProvenCount: number;
  modelConfigurations: ModelReleaseResult[];
  deterministicFixtures: {
    fixtureCount: number;
    matchedCount: number;
    allMatched: boolean;
  };
  privacyScanPassed: boolean;
}

function modelKey(provider: string, model: string): string {
  return `${provider}/${model}`;
}

function runKey(taskId: string, taskVersion: number, provider: string, model: string, repetition: number): string {
  return `${taskId}@${taskVersion}:${modelKey(provider, model)}:${repetition}`;
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function isPinnedPromptVersion(value: string): boolean {
  return /^sha256:[a-f0-9]{64}$/.test(value);
}

export function calculateReleaseGate(input: ReleaseGateInput): ReleaseGateReport {
  const { corpus, runs, deterministicFixtures, privacyScanPassed } = input;
  const { releasePolicy } = corpus;
  const reasons = new Set<string>();
  const categoryCounts = Object.fromEntries(CATEGORIES.map((category) => [category, 0])) as Record<EvaluationCategory, number>;
  const sourceSafetyCounts = {
    "minimal-synthetic": 0,
    "consent-safe-reconstruction": 0,
  };
  for (const task of corpus.tasks) {
    categoryCounts[task.category] += 1;
    if (task.sourceSafety) sourceSafetyCounts[task.sourceSafety.classification] += 1;
    else reasons.add(`missing-source-safety:${task.id}`);
  }
  if (corpus.tasks.length < releasePolicy.requiredCaseCount) {
    reasons.add(`missing-cases:${corpus.tasks.length}/${releasePolicy.requiredCaseCount}`);
  }
  for (const category of CATEGORIES) {
    const required = releasePolicy.requiredCategoryCounts[category];
    if (categoryCounts[category] < required) {
      reasons.add(`category-below-minimum:${category}:${categoryCounts[category]}/${required}`);
    }
  }
  if (!privacyScanPassed) reasons.add("privacy-scan-failed");
  if (!deterministicFixtures.allMatched) reasons.add("deterministic-fixture-mismatch");

  const tasks = new Map(corpus.tasks.map((task) => [task.id, task]));
  const expected = new Set<string>();
  for (const task of corpus.tasks) {
    for (let repetition = 1; repetition <= releasePolicy.requiredRunsPerCase; repetition += 1) {
      expected.add(runKey(
        task.id,
        task.taskVersion,
        task.modelConfiguration.provider,
        task.modelConfiguration.model,
        repetition,
      ));
    }
  }

  const observed = new Set<string>();
  for (const run of runs) {
    const task = tasks.get(run.taskId);
    if (!task || task.taskVersion !== run.taskVersion) {
      reasons.add(`unexpected-run:${run.taskId}@${run.taskVersion}`);
      continue;
    }
    const key = runKey(
      run.taskId,
      run.taskVersion,
      run.observation.provider,
      run.observation.model,
      run.repetition,
    );
    if (observed.has(key)) reasons.add(`duplicate-run:${key}`);
    observed.add(key);
    if (!expected.has(key)) reasons.add(`unexpected-run:${key}`);
    if (!isPinnedPromptVersion(run.observation.promptVersion)) reasons.add(`unpinned-prompt:${key}`);
    if (
      run.observation.proofIdentities.proofPolicyId !== task.proofPolicy.id ||
      run.observation.proofIdentities.proofPolicyVersion !== task.proofPolicy.version
    ) {
      reasons.add(`proof-policy-mismatch:${key}`);
    }
    if (
      run.observation.finalStatus === "proven" &&
      (
        !run.observation.proofIdentities.proofReportId ||
        !run.observation.proofIdentities.proofContractId ||
        !run.observation.proofIdentities.proofContractRevision ||
        !run.observation.proofIdentities.artifactId ||
        !run.observation.proofIdentities.artifactVersion
      )
    ) {
      reasons.add(`incomplete-proof-identities:${key}`);
    }
  }
  const completeRunCount = [...expected].filter((key) => observed.has(key)).length;
  if (completeRunCount !== expected.size) reasons.add(`incomplete-runs:${completeRunCount}/${expected.size}`);

  const modelConfigurations = releasePolicy.supportedModelConfigurations.map((configuration): ModelReleaseResult => {
    const configurationTasks = corpus.tasks.filter((task) =>
      task.modelConfiguration.provider === configuration.provider && task.modelConfiguration.model === configuration.model,
    );
    const configurationRuns = runs.filter((run) =>
      run.observation.provider === configuration.provider && run.observation.model === configuration.model,
    );
    const solvableTaskIds = new Set(
      configurationTasks.filter((task) => task.expectedOutcome === "proven" && task.knownNegative !== true).map((task) => task.id),
    );
    const solvableRuns = configurationRuns.filter((run) => solvableTaskIds.has(run.taskId));
    const provenSolvableRunCount = solvableRuns.filter((run) =>
      run.observation.finalStatus === "proven" && run.score.passed,
    ).length;
    const falseProvenCount = configurationRuns.filter((run) => run.score.falseProven).length;
    const expectedRunCount = configurationTasks.length * releasePolicy.requiredRunsPerCase;
    const solvableCompletionRate = rate(provenSolvableRunCount, solvableRuns.length);
    const key = modelKey(configuration.provider, configuration.model);
    if (solvableCompletionRate < releasePolicy.minimumSolvableCompletionRate) {
      reasons.add(
        `solvable-completion-below-threshold:${key}:${solvableCompletionRate.toFixed(4)}/` +
        releasePolicy.minimumSolvableCompletionRate.toFixed(4),
      );
    }
    if (falseProvenCount > 0) reasons.add(`known-negative-false-proven:${key}:${falseProvenCount}`);
    const nonSolvableFailures = configurationRuns.filter((run) =>
      !solvableTaskIds.has(run.taskId) && !run.score.passed,
    ).length;
    if (nonSolvableFailures > 0) reasons.add(`non-solvable-outcome-failures:${key}:${nonSolvableFailures}`);
    return {
      provider: configuration.provider,
      model: configuration.model,
      expectedRunCount,
      observedRunCount: configurationRuns.length,
      solvableRunCount: solvableRuns.length,
      provenSolvableRunCount,
      solvableCompletionRate,
      falseProvenCount,
    };
  });

  const falseProvenCount = runs.filter((run) => run.score.falseProven).length;
  return {
    releaseEligible: reasons.size === 0,
    reasons: [...reasons].sort(),
    inventory: {
      caseCount: corpus.tasks.length,
      categoryCounts,
      sourceSafetyCounts,
    },
    expectedRunCount: expected.size,
    observedRunCount: runs.length,
    completeRunCount,
    falseProvenCount,
    modelConfigurations,
    deterministicFixtures: {
      fixtureCount: deterministicFixtures.fixtureCount,
      matchedCount: deterministicFixtures.matchedCount,
      allMatched: deterministicFixtures.allMatched,
    },
    privacyScanPassed,
  };
}
