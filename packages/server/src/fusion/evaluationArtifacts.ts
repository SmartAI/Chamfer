import type { FusionCohortComparison, FusionEvaluationAttempt, FusionEvaluationIdentity } from "./evaluation";
import type { FusionSuperiorityGateResult } from "./superiorityGate";

export interface FusionCohortArtifact {
  cohortId: string;
  participant: "chamfer" | "autodesk-assistant";
  executionMode: "scripted" | "live" | "ingested";
  corpusVersion: string;
  corpusSha256: string;
  identity: FusionEvaluationIdentity;
  privacyScan: "passed";
  attempts: Array<{
    caseId: string;
    trial: number;
    verdict: "passed" | "proficiency-failed" | "integrity-failed" | "incomplete";
    eligibleForProficiency: boolean;
    semanticReviewPending: boolean;
    failures: string[];
    executionState: FusionEvaluationAttempt["executionState"];
    observedOutcome?: FusionEvaluationAttempt["observedOutcome"];
    evidence: FusionEvaluationAttempt["evidence"];
    deterministic: FusionEvaluationAttempt["deterministic"];
    semantic: FusionEvaluationAttempt["semantic"];
    diagnostics: FusionEvaluationAttempt["diagnostics"];
  }>;
}

const formatMetric = (candidate: number | undefined, suffix = "") => candidate === undefined ? "-" : `${candidate}${suffix}`;

export function renderFusionCohortMarkdown(artifact: FusionCohortArtifact): string {
  const evidence = artifact.executionMode === "scripted"
    ? "Infrastructure evidence only; scripted attempts are excluded from agent proficiency denominators."
    : "Live or externally ingested attempts are eligible for proficiency only when their individual verdict says so.";
  return [
    "# Fusion evaluation cohort",
    "",
    `Cohort: \`${artifact.cohortId}\`. Participant: ${artifact.participant}. Mode: ${artifact.executionMode}.`,
    `Corpus: \`${artifact.corpusVersion}\` (\`${artifact.corpusSha256}\`).`,
    `Environment: Node ${artifact.identity.environment.nodeVersion} on ${artifact.identity.environment.platform}/${artifact.identity.environment.arch}; browser ${artifact.identity.environment.browser}. Privacy scan: ${artifact.privacyScan}.`,
    "",
    evidence,
    "",
    "| Case | Trial | Ordered verdict | Proficiency eligible | Semantic review | Cost USD | Tokens in/out | Latency | Actions | Elapsed |",
    "| --- | ---: | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |",
    ...artifact.attempts.map((attempt) =>
      `| ${attempt.caseId} | ${attempt.trial} | ${attempt.verdict} | ${attempt.eligibleForProficiency ? "yes" : "no"} | ${attempt.semanticReviewPending ? "pending" : attempt.semantic.status} | ${formatMetric(attempt.diagnostics.costUsd)} | ${formatMetric(attempt.diagnostics.inputTokens)}/${formatMetric(attempt.diagnostics.outputTokens)} | ${formatMetric(attempt.diagnostics.latencyMs, " ms")} | ${attempt.diagnostics.actionCount} | ${attempt.diagnostics.elapsedMs} ms |`),
    "",
    `Integrity failures: ${artifact.attempts.filter((item) => item.verdict === "integrity-failed").length}. Infrastructure failures: ${artifact.attempts.filter((item) => item.executionState === "infrastructure-failure").length}.`,
    "",
  ].join("\n");
}

export function renderFusionComparisonMarkdown(comparison: FusionCohortComparison): string {
  return [
    "# Fusion paired cohort comparison",
    "",
    `Ordered verdict: **${comparison.verdict}**. Required trials per participant and case: ${comparison.requiredTrials}.`,
    "",
    "| Case | Integrity status | Chamfer proficiency | Autodesk proficiency | Semantic review | Efficiency compared |",
    "| --- | --- | ---: | ---: | --- | --- |",
    ...comparison.cases.map((item) =>
      `| ${item.caseId} | ${item.status} | ${item.chamferPasses}/${item.chamferAttempts} | ${item.autodeskPasses}/${item.autodeskAttempts} | ${item.semanticReviewPending ? "pending" : "available"} | ${item.efficiencyCompared ? "yes" : "no"} |`),
    "",
    "## Equivalent-outcome efficiency deltas (Chamfer - Autodesk)",
    "",
    ...comparison.cases.map((item) => `${item.caseId}: ${item.efficiency
      ? Object.entries(item.efficiency).map(([metric, values]) => `${metric}=${values.delta}`).join(", ")
      : "not comparable"}.`),
    "",
    "Deterministic integrity and geometry decide eligibility first. Semantic review covers design intent, editability, and visual quality. Cost, tokens, latency, action count, and elapsed time are compared only among equivalent successful outcomes.",
    "",
  ].join("\n");
}

export function renderFusionSuperiorityGateMarkdown(result: FusionSuperiorityGateResult): string {
  const verdict = result.promotionAllowed ? "CLAIM AUTHORIZED" : "CLAIM BLOCKED";
  return [
    "# Autodesk Assistant superiority gate",
    "",
    `## ${verdict}`,
    "",
    `Comparison date: ${result.comparisonDate}. Promotion allowed: ${result.promotionAllowed ? "yes" : "no"}.`,
    ...(result.reasons.length > 0 ? ["", "Blocking reasons:", ...result.reasons.map((reason) => `- ${reason}`)] : []),
    "",
    "## Full-task proficiency",
    "",
    `Chamfer: ${result.summary.chamfer.successes}/${result.summary.chamfer.attempts}` +
      `${result.summary.chamfer.passRate === null ? "." : ` (${result.summary.chamfer.passRate * 100}%).`}`,
    `Autodesk Assistant: ${result.summary.autodesk.successes}/${result.summary.autodesk.attempts}` +
      `${result.summary.autodesk.passRate === null ? "." : ` (${result.summary.autodesk.passRate * 100}%).`}`,
    ...(result.summary.pairedConfidence95 ? [
      `Absolute advantage: ${result.summary.advantagePercentagePoints} percentage points.`,
      `Confidence method: ${result.summary.pairedConfidence95.method}; 95% interval ` +
        `[${result.summary.pairedConfidence95.lower}, ${result.summary.pairedConfidence95.upper}], ` +
        `${result.summary.pairedConfidence95.samples} samples, seed ${result.summary.pairedConfidence95.seed}.`,
    ] : ["Statistical comparison withheld until every prerequisite evidence gate passes."]),
    "",
    "## Blinded quality",
    "",
    ...Object.entries(result.summary.qualityDimensions).map(([dimension, value]) =>
      `${dimension}: Chamfer ${value.chamferMean}, Autodesk ${value.autodeskMean}, delta ${value.delta}.`),
    `No worse: ${result.summary.blindedQualityNoWorse === null ? "not compared" : result.summary.blindedQualityNoWorse ? "yes" : "no"}. ` +
      (result.summary.reviewerAgreement ? `Human review cohort: ${result.summary.reviewerAgreement.reviewCohortId} ` +
        `(${result.summary.reviewerAgreement.reviewProtocolVersion}); assignments ${result.summary.reviewerAgreement.assignmentsSha256}; ` +
        `reviewed scores ${result.summary.reviewerAgreement.reviewedScoresSha256}. Reviewer agreement: ` +
        `${result.summary.reviewerAgreement.method}=${result.summary.reviewerAgreement.value} ` +
        `across ${result.summary.reviewerAgreement.reviewerCount} reviewers.` : "Human-review evidence unavailable."),
    "",
    "## Per-case outcomes",
    "",
    "| Case | Status | Chamfer success/attempts | Autodesk success/attempts | Chamfer integrity failures |",
    "| --- | --- | ---: | ---: | ---: |",
    ...result.cases.map((item) =>
      `| ${item.caseId} | ${item.status} | ${item.chamferSuccesses}/${item.chamferAttempts} | ${item.autodeskSuccesses}/${item.autodeskAttempts} | ${item.chamferIntegrityFailures} |`),
    "",
    "## Failure classes",
    "",
    ...(Object.keys(result.failureClasses).length === 0 ? ["None."] : Object.entries(result.failureClasses).map(([failure, counts]) =>
      `${failure}: Chamfer ${counts.chamfer}; Autodesk ${counts.autodesk}; gate ${counts.gate}.`)),
    "",
    "## Versions, scope, and limitations",
    "",
    `Chamfer ${result.scope.chamferRelease} at ${result.scope.chamferGitCommit}; agent configuration ${result.scope.chamferAgentConfigurationSha256}.`,
    `Autodesk Assistant ${result.scope.autodeskAssistantVersion}; Fusion ${result.scope.fusionVersion}; evaluator ${result.scope.evaluatorVersion}.`,
    `Corpus ${result.scope.corpusVersion} (${result.scope.corpusSha256}). Tested scope: ${result.scope.testedScope}.`,
    ...result.scope.limitations.map((limitation) => `- ${limitation}`),
    "",
    `Trial order interleaved: ${result.schedule.interleaved ? "yes" : "no"}; maximum consecutive participant runs: ${result.schedule.maximumConsecutiveParticipantRuns}; ` +
      `maximum paired start gap: ${result.schedule.maximumPairedStartGapMs ?? "unavailable"} ms.`,
    "",
    ...(result.summary.efficiency ? [
      "## Efficiency among paired successful outcomes",
      "",
      ...Object.entries(result.summary.efficiency).map(([metric, values]) =>
        `${metric}: Chamfer ${values.chamferMean}, Autodesk ${values.autodeskMean}, delta ${values.delta}, paired attempts ${values.pairedAttempts}.`),
    ] : ["Efficiency metrics are intentionally omitted because one or more prerequisite gates failed."]),
    "",
  ].join("\n");
}
