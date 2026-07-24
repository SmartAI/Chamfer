import { createHash } from "node:crypto";
import {
  isAgentConfigurationIdentity,
  type AgentConfigurationIdentity,
  type AgentEvaluationPillars,
} from "@chamfer/shared";

export const ONLINE_SCORE_SCHEMA_VERSION = 2 as const;

export interface OnlineRunEvidence {
  runId: string;
  release: string;
  configuration: AgentConfigurationIdentity;
  provider: string;
  model: string;
  modality: "text" | "image" | "multimodal";
  lifecycleComplete: boolean;
  planStatus: "completed" | "incomplete" | "unavailable";
  verificationGate: "passed" | "failed" | "unavailable";
  requiredEvidence: number;
  observedEvidence: number;
  completionClaimed: boolean;
  toolCalls: number;
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
  schemaVersion: typeof ONLINE_SCORE_SCHEMA_VERSION;
  runId: string;
  configuration: AgentConfigurationIdentity;
  segment: {
    release: string;
    provider: string;
    model: string;
    modality: OnlineRunEvidence["modality"];
  };
  provenance: { scorer: "online-deterministic"; version: number };
  status: "available" | "unavailable";
  pillars: AgentEvaluationPillars<{
    taskSuccess: { passed: null; status: "unavailable" };
    gateIntegrity: {
      passed: boolean | null;
      suspectedFalseSuccess: boolean;
      evidenceCoverage: number | null;
    };
    cost: { providerCostUsd: number };
    latency: { method: "wall-clock"; totalMs: number };
    toolErrorRate: { errors: number; calls: number; rate: number };
  }>;
  diagnostics: {
    lifecycleComplete: boolean;
    planCompleted: boolean | null;
    cadFailures: number;
    retries: number;
    persistenceFailures: number;
  };
}

export interface ReviewInventoryItem {
  runId: string;
  configuration: AgentConfigurationIdentity;
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
    schemaVersion: ONLINE_SCORE_SCHEMA_VERSION,
    runId: run.runId,
    configuration: run.configuration,
    segment: {
      release: run.release,
      provider: run.provider,
      model: run.model,
      modality: run.modality,
    },
    provenance: { scorer: "online-deterministic", version: policy.version },
    status: available ? "available" : "unavailable",
    pillars: {
      taskSuccess: { passed: null, status: "unavailable" },
      gateIntegrity: {
        passed: run.verificationGate === "unavailable" ? null : run.verificationGate === "passed" &&
          !(run.completionClaimed && run.observedEvidence < run.requiredEvidence),
        suspectedFalseSuccess: run.completionClaimed &&
          (run.verificationGate !== "passed" || run.observedEvidence < run.requiredEvidence),
        evidenceCoverage: run.requiredEvidence > 0 ? run.observedEvidence / run.requiredEvidence : null,
      },
      cost: { providerCostUsd: run.cost },
      latency: { method: "wall-clock", totalMs: run.latencyMs },
      toolErrorRate: {
        errors: run.toolErrors,
        calls: run.toolCalls,
        rate: run.toolCalls === 0 ? 0 : run.toolErrors / run.toolCalls,
      },
    },
    diagnostics: {
      lifecycleComplete: run.lifecycleComplete,
      planCompleted: run.planStatus === "unavailable" ? null : run.planStatus === "completed",
      cadFailures: run.cadFailures,
      retries: run.retries,
      persistenceFailures: run.persistenceFailures,
    },
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
  if (input.runs.some((run) => !isAgentConfigurationIdentity(run.configuration))) {
    throw new Error("Online scoring requires an artifact-derived agent configuration identity");
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
      configuration: run.configuration,
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
