import { canonicalJson } from "./identity";
import type { EvaluationResult } from "./result";
import { calculateCohortVerdict, type RequiredAttempt } from "./verdict";
import type { PrivacyScan } from "./privacy";

export interface ReleaseThresholdPolicy {
  version: number;
  minimumExpectedOutcomeRate: number;
  minimumPerCaseReliability: number;
}

export function isEvaluationResultFilename(filename: string): boolean {
  return /-v[1-9][0-9]*-r[1-9][0-9]*\.json$/.test(filename);
}

interface CaseMetrics {
  attempts: number;
  successful: number;
  expectedOutcomeRate: number;
  firstAttemptMatched: boolean | null;
  cost: number;
  successfulCost: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  wallTimeMs: number;
  modelLatencyMs: number;
  toolLatencyMs: number;
  cadLatencyMs: number;
  compactionLatencyMs: number;
  persistenceLatencyMs: number;
  retryDelayMs: number;
  persistenceFailures: number;
  modelCalls: number;
  toolCalls: number;
  toolErrors: number;
  cadRuns: number;
  searches: number;
  skillLoads: number;
  retries: number;
  compactions: number;
  correctCompletions: number;
  correctEscalations: number;
  correctBlocks: number;
  requiredScoresPassed: number;
  requiredScoresTotal: number;
  planChecksPassed: number;
  planChecksTotal: number;
  verificationGatePassed: number;
  verificationGateTotal: number;
  successfulTotals: {
    cost: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
    wallTimeMs: number;
    modelLatencyMs: number;
    toolLatencyMs: number;
    cadLatencyMs: number;
    compactionLatencyMs: number;
    persistenceLatencyMs: number;
    retryDelayMs: number;
    persistenceFailures: number;
    modelCalls: number;
    toolCalls: number;
    toolErrors: number;
    cadRuns: number;
    searches: number;
    skillLoads: number;
    retries: number;
    compactions: number;
  };
}

export interface CaseComparison {
  caseId: string;
  caseVersion: number;
  modality: EvaluationResult["identities"]["case"]["modality"];
  complexity: EvaluationResult["identities"]["case"]["complexity"];
  categories: string[];
  purpose: string;
  gatingStatus: EvaluationResult["identities"]["case"]["gatingStatus"];
  classification: "improved" | "regressed" | "unchanged" | "incomplete" | "infrastructure-failed";
  candidate: CaseMetrics;
  control: CaseMetrics;
  deltas: {
    expectedOutcomeRate: number;
    cost: number;
    wallTimeMs: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
    modelCalls: number;
    toolCalls: number;
    toolErrors: number;
    cadRuns: number;
    searches: number;
    skillLoads: number;
    retries: number;
    compactions: number;
    modelLatencyMs: number;
    toolLatencyMs: number;
    cadLatencyMs: number;
    compactionLatencyMs: number;
    persistenceLatencyMs: number;
    retryDelayMs: number;
    persistenceFailures: number;
  };
}

export interface CohortComparison {
  schemaVersion: 1;
  policyVersion: number;
  status: "passed" | "failed" | "incomplete" | "unsupported";
  passes: boolean;
  decidingLayer: "integrity" | "proficiency" | "reliability" | "efficiency" | "none";
  warnings: string[];
  cases: CaseComparison[];
  summary: {
    improved: number;
    regressed: number;
    unchanged: number;
    incomplete: number;
    infrastructureFailed: number;
    candidateExpectedOutcomeRate: number;
    controlExpectedOutcomeRate: number;
    candidateProviderCost: number;
    controlProviderCost: number;
    byModality: SegmentMetrics[];
    byComplexity: SegmentMetrics[];
    byCategory: SegmentMetrics[];
    byPurpose: SegmentMetrics[];
    byClassification: SegmentMetrics[];
  };
}

interface SegmentMetrics {
  key: string;
  attempts: number;
  successful: number;
  expectedOutcomeRate: number;
  providerCost: number;
  controlAttempts: number;
  controlSuccessful: number;
  controlExpectedOutcomeRate: number;
  controlProviderCost: number;
  expectedOutcomeRateDelta: number;
  providerCostDelta: number;
}

function caseKey(result: EvaluationResult): string {
  return `${result.identities.case.id}@${result.identities.case.version}`;
}

function compatibleIdentity(result: EvaluationResult) {
  return {
    corpus: result.identities.corpus,
    case: {
      id: result.identities.case.id,
      version: result.identities.case.version,
      hash: result.identities.case.hash,
    },
    evaluators: result.identities.evaluators,
    rubrics: result.identities.rubrics,
    runner: result.identities.runner,
    runtimeEnvironment: {
      node: result.identities.environment.node,
      browser: result.identities.environment.browser,
      operatingSystem: result.identities.environment.operatingSystem,
      architecture: result.identities.environment.architecture,
    },
    provider: result.identities.agentConfiguration.provider,
    model: result.identities.agentConfiguration.model,
    inferenceSettingsHash: result.identities.agentConfiguration.inferenceSettingsHash,
  };
}

function successful(result: EvaluationResult): boolean {
  return result.execution.state === "completed" &&
    result.outcome.expectedMatch &&
    result.integrity.violations.length === 0 &&
    result.scores.filter((score) => score.required).every((score) => score.status === "passed");
}

function metrics(results: EvaluationResult[]): CaseMetrics {
  const ordered = [...results].sort((left, right) =>
    left.identities.repetition.index - right.identities.repetition.index
  );
  const successResults = ordered.filter(successful);
  const sum = (items: EvaluationResult[], value: (result: EvaluationResult) => number) =>
    items.reduce((total, result) => total + value(result), 0);
  const requiredScores = ordered.flatMap((result) => result.scores.filter((score) => score.required));
  const planChecks = ordered.flatMap((result) => result.scores.filter((score) => score.id.includes("plan")));
  const verificationGates = ordered.flatMap((result) =>
    result.scores.filter((score) => score.id === "verification-gate")
  );
  return {
    attempts: ordered.length,
    successful: successResults.length,
    expectedOutcomeRate: ordered.length ? successResults.length / ordered.length : 0,
    firstAttemptMatched: ordered.length ? successful(ordered[0]!) : null,
    cost: ordered.reduce((sum, result) => sum + result.measurements.providerCost, 0),
    successfulCost: successResults.reduce((sum, result) => sum + result.measurements.providerCost, 0),
    inputTokens: ordered.reduce((sum, result) => sum + result.measurements.inputTokens, 0),
    outputTokens: ordered.reduce((sum, result) => sum + result.measurements.outputTokens, 0),
    cacheReadTokens: ordered.reduce((sum, result) => sum + result.measurements.cacheReadTokens, 0),
    cacheWriteTokens: ordered.reduce((sum, result) => sum + result.measurements.cacheWriteTokens, 0),
    reasoningTokens: ordered.reduce((sum, result) => sum + result.measurements.reasoningTokens, 0),
    wallTimeMs: ordered.reduce((sum, result) => sum + result.execution.durationMs, 0),
    modelLatencyMs: ordered.reduce((sum, result) => sum + (result.measurements.modelLatencyMs ?? 0), 0),
    toolLatencyMs: ordered.reduce((sum, result) => sum + (result.measurements.toolLatencyMs ?? 0), 0),
    cadLatencyMs: ordered.reduce((sum, result) => sum + (result.measurements.cadLatencyMs ?? 0), 0),
    compactionLatencyMs: ordered.reduce((sum, result) => sum + (result.measurements.compactionLatencyMs ?? 0), 0),
    persistenceLatencyMs: ordered.reduce((sum, result) => sum + (result.measurements.persistenceLatencyMs ?? 0), 0),
    retryDelayMs: ordered.reduce((sum, result) => sum + (result.measurements.retryDelayMs ?? 0), 0),
    persistenceFailures: ordered.reduce((sum, result) => sum + (result.measurements.persistenceFailures ?? 0), 0),
    modelCalls: ordered.reduce((sum, result) => sum + result.measurements.modelCalls, 0),
    toolCalls: ordered.reduce((sum, result) => sum + result.measurements.toolCalls, 0),
    toolErrors: ordered.reduce((sum, result) => sum + result.measurements.toolErrors, 0),
    cadRuns: ordered.reduce((sum, result) => sum + result.measurements.cadRuns, 0),
    searches: ordered.reduce((sum, result) => sum + (result.measurements.searches ?? 0), 0),
    skillLoads: ordered.reduce((sum, result) => sum + (result.measurements.skillLoads ?? 0), 0),
    retries: ordered.reduce((sum, result) => sum + (result.measurements.retries ?? 0), 0),
    compactions: ordered.reduce((sum, result) => sum + (result.measurements.compactions ?? 0), 0),
    correctCompletions: successResults.filter((result) => result.outcome.kind === "completed").length,
    correctEscalations: successResults.filter((result) => result.outcome.kind === "escalated").length,
    correctBlocks: successResults.filter((result) => result.outcome.kind === "blocked").length,
    requiredScoresPassed: requiredScores.filter((score) => score.status === "passed").length,
    requiredScoresTotal: requiredScores.length,
    planChecksPassed: planChecks.filter((score) => score.status === "passed").length,
    planChecksTotal: planChecks.length,
    verificationGatePassed: verificationGates.filter((score) => score.status === "passed").length,
    verificationGateTotal: verificationGates.length,
    successfulTotals: {
      cost: sum(successResults, (result) => result.measurements.providerCost),
      inputTokens: sum(successResults, (result) => result.measurements.inputTokens),
      outputTokens: sum(successResults, (result) => result.measurements.outputTokens),
      cacheReadTokens: sum(successResults, (result) => result.measurements.cacheReadTokens),
      cacheWriteTokens: sum(successResults, (result) => result.measurements.cacheWriteTokens),
      reasoningTokens: sum(successResults, (result) => result.measurements.reasoningTokens),
      wallTimeMs: sum(successResults, (result) => result.execution.durationMs),
      modelLatencyMs: sum(successResults, (result) => result.measurements.modelLatencyMs ?? 0),
      toolLatencyMs: sum(successResults, (result) => result.measurements.toolLatencyMs ?? 0),
      cadLatencyMs: sum(successResults, (result) => result.measurements.cadLatencyMs ?? 0),
      compactionLatencyMs: sum(successResults, (result) => result.measurements.compactionLatencyMs ?? 0),
      persistenceLatencyMs: sum(successResults, (result) => result.measurements.persistenceLatencyMs ?? 0),
      retryDelayMs: sum(successResults, (result) => result.measurements.retryDelayMs ?? 0),
      persistenceFailures: sum(successResults, (result) => result.measurements.persistenceFailures ?? 0),
      modelCalls: sum(successResults, (result) => result.measurements.modelCalls),
      toolCalls: sum(successResults, (result) => result.measurements.toolCalls),
      toolErrors: sum(successResults, (result) => result.measurements.toolErrors),
      cadRuns: sum(successResults, (result) => result.measurements.cadRuns),
      searches: sum(successResults, (result) => result.measurements.searches ?? 0),
      skillLoads: sum(successResults, (result) => result.measurements.skillLoads ?? 0),
      retries: sum(successResults, (result) => result.measurements.retries ?? 0),
      compactions: sum(successResults, (result) => result.measurements.compactions ?? 0),
    },
  };
}

function segmentMetrics(cases: CaseComparison[], keys: (item: CaseComparison) => string[]): SegmentMetrics[] {
  const segments = new Map<string, CaseComparison[]>();
  for (const item of cases) {
    for (const key of keys(item)) segments.set(key, [...(segments.get(key) ?? []), item]);
  }
  return [...segments.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, items]) => {
    const attempts = items.reduce((sum, item) => sum + item.candidate.attempts, 0);
    const successful = items.reduce((sum, item) => sum + item.candidate.successful, 0);
    const controlAttempts = items.reduce((sum, item) => sum + item.control.attempts, 0);
    const controlSuccessful = items.reduce((sum, item) => sum + item.control.successful, 0);
    const providerCost = items.reduce((sum, item) => sum + item.candidate.cost, 0);
    const controlProviderCost = items.reduce((sum, item) => sum + item.control.cost, 0);
    const expectedOutcomeRate = attempts ? successful / attempts : 0;
    const controlExpectedOutcomeRate = controlAttempts ? controlSuccessful / controlAttempts : 0;
    return {
      key,
      attempts,
      successful,
      expectedOutcomeRate,
      providerCost,
      controlAttempts,
      controlSuccessful,
      controlExpectedOutcomeRate,
      controlProviderCost,
      expectedOutcomeRateDelta: expectedOutcomeRate - controlExpectedOutcomeRate,
      providerCostDelta: providerCost - controlProviderCost,
    };
  });
}

function group(results: EvaluationResult[]): Map<string, EvaluationResult[]> {
  const grouped = new Map<string, EvaluationResult[]>();
  for (const result of results) {
    const key = caseKey(result);
    grouped.set(key, [...(grouped.get(key) ?? []), result]);
  }
  return grouped;
}

function compatibilityWarnings(candidate: EvaluationResult[], control: EvaluationResult[]): string[] {
  const warnings: string[] = [];
  const candidateGroups = group(candidate);
  const controlGroups = group(control);
  const allKeys = new Set([...candidateGroups.keys(), ...controlGroups.keys()]);
  for (const key of allKeys) {
    const candidateResult = candidateGroups.get(key)?.[0];
    const controlResult = controlGroups.get(key)?.[0];
    if (!candidateResult || !controlResult) {
      warnings.push(`Case inventory mismatch for ${key}.`);
      continue;
    }
    const left = compatibleIdentity(candidateResult);
    const right = compatibleIdentity(controlResult);
    if (left.corpus.hash !== right.corpus.hash) warnings.push(`Corpus identity mismatch for ${key}.`);
    if (left.case.hash !== right.case.hash) warnings.push(`Case identity mismatch for ${key}.`);
    if (canonicalJson(left.evaluators) !== canonicalJson(right.evaluators)) {
      warnings.push(`Evaluator identity mismatch for ${key}.`);
    }
    if (canonicalJson(left.rubrics) !== canonicalJson(right.rubrics)) {
      warnings.push(`Rubric identity mismatch for ${key}.`);
    }
    if (canonicalJson(left.runner) !== canonicalJson(right.runner)) warnings.push(`Runner identity mismatch for ${key}.`);
    if (canonicalJson(left.runtimeEnvironment) !== canonicalJson(right.runtimeEnvironment)) {
      warnings.push(`Runtime environment mismatch for ${key}.`);
    }
    if (left.provider !== right.provider || left.model !== right.model ||
        left.inferenceSettingsHash !== right.inferenceSettingsHash) {
      warnings.push(`Model identity mismatch for ${key}.`);
    }
  }
  return warnings;
}

export function compareCohorts(input: {
  candidate: EvaluationResult[];
  control: EvaluationResult[];
  requiredAttempts: RequiredAttempt[];
  policy: ReleaseThresholdPolicy;
  candidatePrivacy?: PrivacyScan;
  controlPrivacy?: PrivacyScan;
}): CohortComparison {
  const warnings = compatibilityWarnings(input.candidate, input.control);
  if (input.controlPrivacy?.status === "failed") warnings.push("Control privacy scan failed.");
  if (warnings.length > 0) {
    return {
      schemaVersion: 1,
      policyVersion: input.policy.version,
      status: "unsupported",
      passes: false,
      decidingLayer: "integrity",
      warnings,
      cases: [],
      summary: {
        improved: 0,
        regressed: 0,
        unchanged: 0,
        incomplete: 0,
        infrastructureFailed: 0,
        candidateExpectedOutcomeRate: 0,
        controlExpectedOutcomeRate: 0,
        candidateProviderCost: 0,
        controlProviderCost: 0,
        byModality: [],
        byComplexity: [],
        byCategory: [],
        byPurpose: [],
        byClassification: [],
      },
    };
  }

  const candidateGroups = group(input.candidate);
  const controlGroups = group(input.control);
  const cases: CaseComparison[] = [];
  for (const [key, candidateResults] of candidateGroups) {
    const controlResults = controlGroups.get(key) ?? [];
    const candidate = metrics(candidateResults);
    const control = metrics(controlResults);
    const exemplar = candidateResults[0]!;
    const infrastructureFailed = [...candidateResults, ...controlResults]
      .some((result) => result.outcome.kind === "infrastructure-failure");
    const incomplete = candidate.attempts !== control.attempts || [...candidateResults, ...controlResults]
      .some((result) => result.execution.state !== "completed" ||
        result.scores.some((score) => score.required && score.status === "unavailable"));
    const integrityFailed = candidateResults.some((result) => result.integrity.violations.length > 0 ||
      (result.outcome.kind === "completed" && result.scores.some((score) => score.required && score.status !== "passed"))
    );
    let classification: CaseComparison["classification"];
    if (infrastructureFailed) classification = "infrastructure-failed";
    else if (incomplete) classification = "incomplete";
    else if (integrityFailed || candidate.expectedOutcomeRate < control.expectedOutcomeRate) classification = "regressed";
    else if (candidate.expectedOutcomeRate > control.expectedOutcomeRate) classification = "improved";
    else if (candidate.successful === control.successful && candidate.successfulCost < control.successfulCost) {
      classification = "improved";
    } else {
      classification = "unchanged";
    }
    cases.push({
      caseId: exemplar.identities.case.id,
      caseVersion: exemplar.identities.case.version,
      modality: exemplar.identities.case.modality,
      complexity: exemplar.identities.case.complexity,
      categories: exemplar.identities.case.categories,
      purpose: exemplar.identities.case.purpose,
      gatingStatus: exemplar.identities.case.gatingStatus,
      classification,
      candidate,
      control,
      deltas: {
        expectedOutcomeRate: candidate.expectedOutcomeRate - control.expectedOutcomeRate,
        cost: candidate.cost - control.cost,
        wallTimeMs: candidate.wallTimeMs - control.wallTimeMs,
        inputTokens: candidate.inputTokens - control.inputTokens,
        outputTokens: candidate.outputTokens - control.outputTokens,
        cacheReadTokens: candidate.cacheReadTokens - control.cacheReadTokens,
        cacheWriteTokens: candidate.cacheWriteTokens - control.cacheWriteTokens,
        reasoningTokens: candidate.reasoningTokens - control.reasoningTokens,
        modelCalls: candidate.modelCalls - control.modelCalls,
        toolCalls: candidate.toolCalls - control.toolCalls,
        toolErrors: candidate.toolErrors - control.toolErrors,
        cadRuns: candidate.cadRuns - control.cadRuns,
        searches: candidate.searches - control.searches,
        skillLoads: candidate.skillLoads - control.skillLoads,
        retries: candidate.retries - control.retries,
        compactions: candidate.compactions - control.compactions,
        modelLatencyMs: candidate.modelLatencyMs - control.modelLatencyMs,
        toolLatencyMs: candidate.toolLatencyMs - control.toolLatencyMs,
        cadLatencyMs: candidate.cadLatencyMs - control.cadLatencyMs,
        compactionLatencyMs: candidate.compactionLatencyMs - control.compactionLatencyMs,
        persistenceLatencyMs: candidate.persistenceLatencyMs - control.persistenceLatencyMs,
        retryDelayMs: candidate.retryDelayMs - control.retryDelayMs,
        persistenceFailures: candidate.persistenceFailures - control.persistenceFailures,
      },
    });
  }
  cases.sort((left, right) => left.caseId.localeCompare(right.caseId) || left.caseVersion - right.caseVersion);

  const candidateVerdict = calculateCohortVerdict({
    results: input.candidate,
    requiredAttempts: input.requiredAttempts,
    privacy: input.candidatePrivacy ?? { status: "passed", findings: [] },
  });
  const controlVerdict = calculateCohortVerdict({
    results: input.control,
    requiredAttempts: input.requiredAttempts,
    privacy: input.controlPrivacy ?? { status: "passed", findings: [] },
  });
  const gatingCases = cases.filter((item) => item.gatingStatus === "release");
  const gatingCandidateAttempts = gatingCases.reduce((sum, item) => sum + item.candidate.attempts, 0);
  const gatingCandidateSuccesses = gatingCases.reduce((sum, item) => sum + item.candidate.successful, 0);
  const candidateExpectedOutcomeRate = gatingCandidateAttempts
    ? gatingCandidateSuccesses / gatingCandidateAttempts
    : 0;
  const gatingControlAttempts = gatingCases.reduce((sum, item) => sum + item.control.attempts, 0);
  const gatingControlSuccesses = gatingCases.reduce((sum, item) => sum + item.control.successful, 0);
  const controlExpectedOutcomeRate = gatingControlAttempts ? gatingControlSuccesses / gatingControlAttempts : 0;
  const thresholdRegression = candidateExpectedOutcomeRate < input.policy.minimumExpectedOutcomeRate ||
    gatingCases.some((item) => item.candidate.expectedOutcomeRate < input.policy.minimumPerCaseReliability);
  const incomplete = cases.some((item) => item.classification === "incomplete" ||
    item.classification === "infrastructure-failed");
  const integrityFailed = candidateVerdict.layers.integrity.status === "failed" ||
    controlVerdict.layers.integrity.status === "failed";
  const integrityIncomplete = candidateVerdict.layers.integrity.status === "incomplete" ||
    controlVerdict.layers.integrity.status === "incomplete" || incomplete;
  const status: CohortComparison["status"] = integrityFailed ? "failed"
    : integrityIncomplete ? "incomplete"
    : candidateVerdict.status === "failed" || thresholdRegression ? "failed"
    : "passed";
  const decidingLayer: CohortComparison["decidingLayer"] = integrityFailed || integrityIncomplete
    ? "integrity"
    : thresholdRegression || candidateVerdict.decidingLayer === "proficiency" ? "proficiency"
    : "none";
  return {
    schemaVersion: 1,
    policyVersion: input.policy.version,
    status,
    passes: status === "passed",
    decidingLayer,
    warnings: [],
    cases,
    summary: {
      improved: cases.filter((item) => item.classification === "improved").length,
      regressed: cases.filter((item) => item.classification === "regressed").length,
      unchanged: cases.filter((item) => item.classification === "unchanged").length,
      incomplete: cases.filter((item) => item.classification === "incomplete").length,
      infrastructureFailed: cases.filter((item) => item.classification === "infrastructure-failed").length,
      candidateExpectedOutcomeRate,
      controlExpectedOutcomeRate,
      candidateProviderCost: cases.reduce((sum, item) => sum + item.candidate.cost, 0),
      controlProviderCost: cases.reduce((sum, item) => sum + item.control.cost, 0),
      byModality: segmentMetrics(cases, (item) => [item.modality]),
      byComplexity: segmentMetrics(cases, (item) => [item.complexity]),
      byCategory: segmentMetrics(cases, (item) => item.categories),
      byPurpose: segmentMetrics(cases, (item) => [item.purpose]),
      byClassification: segmentMetrics(cases, (item) => [item.classification]),
    },
  };
}

export function renderCohortComparison(comparison: CohortComparison): string {
  const lines = [
    "# Release Cohort Comparison",
    "",
    `Verdict: ${comparison.status}.`,
    `Deciding layer: ${comparison.decidingLayer}.`,
    `Threshold policy: v${comparison.policyVersion}.`,
    `Candidate provider cost: $${comparison.summary.candidateProviderCost.toFixed(4)}.`,
    `Control provider cost: $${comparison.summary.controlProviderCost.toFixed(4)}.`,
    "",
  ];
  for (const warning of comparison.warnings) lines.push(`- Unsupported: ${warning}`);
  if (comparison.warnings.length) lines.push("");
  lines.push(
    "| Case | Classification | Candidate | Control | Outcome delta | Cost delta | Correct C/E/B | Required scores | Gate evidence |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...comparison.cases.map((item) =>
      `| ${item.caseId} v${item.caseVersion} | ${item.classification} | ${item.candidate.successful}/${item.candidate.attempts} | ${item.control.successful}/${item.control.attempts} | ${item.deltas.expectedOutcomeRate.toFixed(3)} | ${item.deltas.cost.toFixed(4)} | ${item.candidate.correctCompletions}/${item.candidate.correctEscalations}/${item.candidate.correctBlocks} | ${item.candidate.requiredScoresPassed}/${item.candidate.requiredScoresTotal} | ${item.candidate.verificationGatePassed}/${item.candidate.verificationGateTotal} |`
    ),
    "",
    "## Per-case operational totals",
    "",
    "Candidate and control values are absolute totals over all attempts; the parenthesized value is the candidate delta.",
    "",
    "| Case | Tokens in/out | Cost | Wall ms | Model/tool calls | Tool errors | CAD | Search/skills | Retries/compactions |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...comparison.cases.map((item) =>
      `| ${item.caseId} v${item.caseVersion} | ${item.candidate.inputTokens}/${item.candidate.outputTokens} vs ${item.control.inputTokens}/${item.control.outputTokens} (${item.deltas.inputTokens}/${item.deltas.outputTokens}) | ${item.candidate.cost.toFixed(4)} vs ${item.control.cost.toFixed(4)} (${item.deltas.cost.toFixed(4)}) | ${item.candidate.wallTimeMs} vs ${item.control.wallTimeMs} (${item.deltas.wallTimeMs}) | ${item.candidate.modelCalls}/${item.candidate.toolCalls} vs ${item.control.modelCalls}/${item.control.toolCalls} (${item.deltas.modelCalls}/${item.deltas.toolCalls}) | ${item.candidate.toolErrors} vs ${item.control.toolErrors} (${item.deltas.toolErrors}) | ${item.candidate.cadRuns} vs ${item.control.cadRuns} (${item.deltas.cadRuns}) | ${item.candidate.searches}/${item.candidate.skillLoads} vs ${item.control.searches}/${item.control.skillLoads} (${item.deltas.searches}/${item.deltas.skillLoads}) | ${item.candidate.retries}/${item.candidate.compactions} vs ${item.control.retries}/${item.control.compactions} (${item.deltas.retries}/${item.deltas.compactions}) |`
    ),
    "",
    "Cache read/write and reasoning token totals, successful-attempt totals, stage latencies, retry delay, and persistence failures are retained in comparison.json.",
    "",
    "## Candidate segment summaries",
    "",
    "| Dimension | Segment | Candidate | Control | Rate delta | Candidate cost | Control cost | Cost delta |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...(["Modality", "Complexity", "Category", "Purpose", "Classification"] as const).flatMap((dimension) => {
      const values = dimension === "Modality" ? comparison.summary.byModality
        : dimension === "Complexity" ? comparison.summary.byComplexity
        : dimension === "Category" ? comparison.summary.byCategory
        : dimension === "Purpose" ? comparison.summary.byPurpose
        : comparison.summary.byClassification;
      return values.map((item) =>
        `| ${dimension} | ${item.key.replaceAll("|", "\\|")} | ${item.successful}/${item.attempts} (${item.expectedOutcomeRate.toFixed(3)}) | ${item.controlSuccessful}/${item.controlAttempts} (${item.controlExpectedOutcomeRate.toFixed(3)}) | ${item.expectedOutcomeRateDelta.toFixed(3)} | ${item.providerCost.toFixed(4)} | ${item.controlProviderCost.toFixed(4)} | ${item.providerCostDelta.toFixed(4)} |`
      );
    }),
    "",
  );
  return lines.join("\n");
}
