import type { ExpectedOutcome, RequiredProofEvidence } from "./schema";

export type ObservedFinalStatus = ExpectedOutcome | "unproven" | "error";

export interface ProofIdentities {
  proofReportId?: string;
  proofContractId?: string;
  proofContractRevision?: number;
  proofPolicyId: string;
  proofPolicyVersion: number;
  planId?: string;
  criteriaRevision?: number;
  artifactId?: string;
  artifactVersion?: number;
}

export interface EvaluationObservation {
  provider: string;
  model: string;
  promptVersion: string;
  latencyMs: number;
  tokenUse: {
    input: number;
    output: number;
    total: number;
  };
  cadRunCount: number;
  finalStatus: ObservedFinalStatus;
  evidence: RequiredProofEvidence[];
  proofIdentities: ProofIdentities;
  infrastructureError?: string;
}

export interface EvaluationScore {
  passed: boolean;
  falseProven: boolean;
  outcomeMatched: boolean;
  missingEvidence: RequiredProofEvidence[];
  reasons: string[];
}

export interface ScoreExpectation {
  expectedOutcome: ExpectedOutcome;
  requiredProofEvidence: RequiredProofEvidence[];
  knownNegative?: boolean;
}

export function scoreObservation(
  expectation: ScoreExpectation,
  observation: EvaluationObservation,
): EvaluationScore {
  const falseProven = expectation.knownNegative === true && observation.finalStatus === "proven";
  const outcomeMatched = observation.finalStatus === expectation.expectedOutcome;
  const observed = new Set(observation.evidence);
  const missingEvidence = expectation.requiredProofEvidence.filter((evidence) => !observed.has(evidence));
  const reasons: string[] = [];
  if (observation.infrastructureError) reasons.push("infrastructure-error");
  if (!outcomeMatched) reasons.push(`expected-${expectation.expectedOutcome}-observed-${observation.finalStatus}`);
  if (missingEvidence.length > 0) reasons.push(`missing-evidence:${missingEvidence.join(",")}`);
  if (falseProven) reasons.push("known-negative-received-proven-status");
  return {
    passed: !observation.infrastructureError && outcomeMatched && missingEvidence.length === 0 && !falseProven,
    falseProven,
    outcomeMatched,
    missingEvidence,
    reasons,
  };
}

export interface ScoredRun {
  taskId: string;
  taskVersion: number;
  category: string;
  repetition: number;
  observation: EvaluationObservation;
  score: EvaluationScore;
  trace: SanitizedTraceEntry[];
}

export interface SanitizedTraceEntry {
  seq: number;
  role: string;
  toolName?: string;
  stopReason?: string;
  isError?: boolean;
  gateStatus?: string;
}

export interface EvaluationAggregate {
  runCount: number;
  passedRunCount: number;
  failedRunCount: number;
  falseProvenCount: number;
  provenCompletionCount: number;
  escalationCount: number;
  blockedCount: number;
  unprovenCount: number;
  allRunsPassed: boolean;
}

export function aggregateRuns(runs: readonly ScoredRun[]): EvaluationAggregate {
  const count = (status: ObservedFinalStatus) => runs.filter((run) => run.observation.finalStatus === status).length;
  const falseProvenCount = runs.filter((run) => run.score.falseProven).length;
  const failedRunCount = runs.filter((run) => !run.score.passed).length;
  return {
    runCount: runs.length,
    passedRunCount: runs.length - failedRunCount,
    failedRunCount,
    falseProvenCount,
    provenCompletionCount: count("proven"),
    escalationCount: count("escalated"),
    blockedCount: count("blocked"),
    unprovenCount: count("unproven"),
    allRunsPassed: runs.length > 0 && failedRunCount === 0 && falseProvenCount === 0,
  };
}
