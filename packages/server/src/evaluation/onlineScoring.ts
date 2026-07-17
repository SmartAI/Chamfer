import { createHash } from "node:crypto";

export interface OnlineRunEvidence {
  runId: string;
  release: string;
  agentConfigurationHash: string;
  provider: string;
  model: string;
  modality: "text" | "image" | "multimodal";
  lifecycleComplete: boolean;
  planStatus: "completed" | "incomplete" | "unavailable";
  verificationGate: "passed" | "failed" | "unavailable";
  requiredEvidence: number;
  observedEvidence: number;
  completionClaimed: boolean;
  toolErrors: number;
  cadFailures: number;
  retries: number;
  cost: number;
  latencyMs: number;
  persistenceFailures: number;
  explicitFeedback?: "positive" | "negative";
  failureSignature?: string;
}

export interface OnlineSamplingPolicy {
  version: number;
  randomSampleRate: number;
  maximumReviewItems: number;
  unusualCost: number;
  unusualLatencyMs: number;
  toolErrorCluster: number;
  repeatedCadFailures: number;
}

export type ReviewReason =
  | "new-release"
  | "explicit-negative-feedback"
  | "unusual-cost"
  | "unusual-latency"
  | "tool-error-cluster"
  | "repeated-cad-failures"
  | "suspected-false-success"
  | "new-failure-signature"
  | "incomplete-lifecycle"
  | "random-sample";

export interface OnlineDeterministicScore {
  schemaVersion: 1;
  runId: string;
  segment: {
    release: string;
    agentConfigurationHash: string;
    provider: string;
    model: string;
    modality: OnlineRunEvidence["modality"];
  };
  provenance: { scorer: "online-deterministic"; version: number };
  status: "available" | "unavailable";
  taskSuccess: "unavailable";
  lifecycleComplete: boolean;
  planCompleted: boolean | null;
  verificationGatePassed: boolean | null;
  evidenceCoverage: number | null;
  suspectedFalseSuccess: boolean;
  cost: number;
  latencyMs: number;
  toolErrors: number;
  cadFailures: number;
  retries: number;
  persistenceFailures: number;
}

export interface ReviewInventoryItem {
  runId: string;
  reasons: ReviewReason[];
  sampledByPolicyVersion: number;
  segment: OnlineDeterministicScore["segment"];
}

function stableRandom(runId: string): number {
  const bytes = createHash("sha256").update(runId).digest();
  return bytes.readUInt32BE(0) / 2 ** 32;
}

function riskReasons(input: {
  run: OnlineRunEvidence;
  policy: OnlineSamplingPolicy;
  knownReleases: Set<string>;
  knownFailureSignatures: Set<string>;
}): ReviewReason[] {
  const reasons: ReviewReason[] = [];
  const { run, policy } = input;
  if (!input.knownReleases.has(run.release)) reasons.push("new-release");
  if (run.explicitFeedback === "negative") reasons.push("explicit-negative-feedback");
  if (run.cost > policy.unusualCost) reasons.push("unusual-cost");
  if (run.latencyMs > policy.unusualLatencyMs) reasons.push("unusual-latency");
  if (run.toolErrors >= policy.toolErrorCluster) reasons.push("tool-error-cluster");
  if (run.cadFailures >= policy.repeatedCadFailures) reasons.push("repeated-cad-failures");
  if (run.completionClaimed && (run.verificationGate !== "passed" || run.observedEvidence < run.requiredEvidence)) {
    reasons.push("suspected-false-success");
  }
  if (run.failureSignature && !input.knownFailureSignatures.has(run.failureSignature)) {
    reasons.push("new-failure-signature");
  }
  if (!run.lifecycleComplete || run.persistenceFailures > 0) reasons.push("incomplete-lifecycle");
  return reasons;
}

function score(run: OnlineRunEvidence, policy: OnlineSamplingPolicy): OnlineDeterministicScore {
  const available = run.lifecycleComplete && run.persistenceFailures === 0;
  return {
    schemaVersion: 1,
    runId: run.runId,
    segment: {
      release: run.release,
      agentConfigurationHash: run.agentConfigurationHash,
      provider: run.provider,
      model: run.model,
      modality: run.modality,
    },
    provenance: { scorer: "online-deterministic", version: policy.version },
    status: available ? "available" : "unavailable",
    taskSuccess: "unavailable",
    lifecycleComplete: run.lifecycleComplete,
    planCompleted: run.planStatus === "unavailable" ? null : run.planStatus === "completed",
    verificationGatePassed: run.verificationGate === "unavailable" ? null : run.verificationGate === "passed",
    evidenceCoverage: run.requiredEvidence > 0 ? run.observedEvidence / run.requiredEvidence : null,
    suspectedFalseSuccess: run.completionClaimed &&
      (run.verificationGate !== "passed" || run.observedEvidence < run.requiredEvidence),
    cost: run.cost,
    latencyMs: run.latencyMs,
    toolErrors: run.toolErrors,
    cadFailures: run.cadFailures,
    retries: run.retries,
    persistenceFailures: run.persistenceFailures,
  };
}

export function scoreOnlineRuns(input: {
  runs: OnlineRunEvidence[];
  policy: OnlineSamplingPolicy;
  knownReleases: string[];
  knownFailureSignatures: string[];
  previouslySelectedRunIds: string[];
}): { scores: OnlineDeterministicScore[]; reviewInventory: ReviewInventoryItem[] } {
  if (input.policy.randomSampleRate < 0 || input.policy.randomSampleRate > 1) {
    throw new Error("Random sample rate must be between zero and one");
  }
  const knownReleases = new Set(input.knownReleases);
  const knownFailureSignatures = new Set(input.knownFailureSignatures);
  const previouslySelected = new Set(input.previouslySelectedRunIds);
  const scores = input.runs.map((run) => score(run, input.policy));
  const candidates = input.runs
    .filter((run) => !previouslySelected.has(run.runId))
    .map((run, index) => {
      const reasons = riskReasons({ run, policy: input.policy, knownReleases, knownFailureSignatures });
      if (reasons.length === 0 && stableRandom(run.runId) < input.policy.randomSampleRate) reasons.push("random-sample");
      return { run, index, reasons };
    })
    .filter((candidate) => candidate.reasons.length > 0)
    .sort((left, right) => {
      const leftRandom = left.reasons.length === 1 && left.reasons[0] === "random-sample";
      const rightRandom = right.reasons.length === 1 && right.reasons[0] === "random-sample";
      return Number(leftRandom) - Number(rightRandom) || left.index - right.index;
    })
    .slice(0, input.policy.maximumReviewItems);
  return {
    scores,
    reviewInventory: candidates.map(({ run, reasons }) => ({
      runId: run.runId,
      reasons,
      sampledByPolicyVersion: input.policy.version,
      segment: score(run, input.policy).segment,
    })),
  };
}

export function safeScoreOnlineRuns<T>(operation: () => T): T | { status: "unavailable"; reason: string } {
  try {
    return operation();
  } catch (error) {
    return { status: "unavailable", reason: error instanceof Error ? error.message : String(error) };
  }
}
