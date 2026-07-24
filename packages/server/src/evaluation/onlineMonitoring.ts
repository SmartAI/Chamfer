import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AgentRunLifecycleDto } from "@chamfer/shared";
import {
  scoreOnlineRuns,
  type OnlineRunEvidence,
  type OnlineSamplingPolicy,
  type ReviewReason,
} from "./onlineScoring";

const productionSamplingPolicy: OnlineSamplingPolicy = {
  version: 1,
  randomSampleRate: 0.02,
  maximumReviewItems: 1,
  unusualCost: 1,
  unusualLatencyMs: 10 * 60_000,
  toolErrorCluster: 3,
  repeatedCadFailures: 2,
};

function eventDiagnostics(db: DatabaseSync, runId: string): { toolErrors: number; cadFailures: number } {
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_run_events'").get();
  if (!table) return { toolErrors: 0, cadFailures: 0 };
  const rows = db.prepare("SELECT event_json FROM agent_run_events WHERE run_id = ? ORDER BY seq").all(runId) as Array<{
    event_json: string;
  }>;
  const cadOperations = new Set<string>();
  let toolErrors = 0;
  let cadFailures = 0;
  for (const row of rows) {
    const event = JSON.parse(row.event_json) as { type?: string; operationId?: string; name?: string; outcome?: string };
    if (event.type === "tool.started" && event.name === "run_build123d" && event.operationId) {
      cadOperations.add(event.operationId);
    }
    if (event.type === "tool.completed" && event.outcome === "error") {
      toolErrors += 1;
      if (event.operationId && cadOperations.has(event.operationId)) cadFailures += 1;
    }
  }
  return { toolErrors, cadFailures };
}

function observableModality(db: DatabaseSync, conversationId: string): OnlineRunEvidence["modality"] {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM attachments WHERE message_id IN
    (SELECT id FROM messages WHERE conversation_id = ?) AND kind = 'user-image'`).get(conversationId) as { count: number };
  return row.count > 0 ? "multimodal" : "text";
}

function structuredMessageEvidence(db: DatabaseSync, conversationId: string): {
  cost: number;
  planStatus: OnlineRunEvidence["planStatus"];
} {
  const rows = db.prepare("SELECT content_json FROM messages WHERE conversation_id = ? ORDER BY seq ASC")
    .all(conversationId) as Array<{ content_json: string }>;
  let cost = 0;
  let planStatus: OnlineRunEvidence["planStatus"] = "unavailable";
  for (const row of rows) {
    const message = JSON.parse(row.content_json) as {
      role?: string;
      toolName?: string;
      isError?: boolean;
      usage?: { cost?: { total?: unknown } };
      details?: { plan?: { components?: Array<{ status?: unknown }> } };
    };
    const reportedCost = message.usage?.cost?.total;
    if (message.role === "assistant" && typeof reportedCost === "number" && Number.isFinite(reportedCost)) {
      cost += Math.max(0, reportedCost);
    }
    const components = message.details?.plan?.components;
    if (message.role === "toolResult" && message.toolName === "update_plan" && message.isError !== true &&
        Array.isArray(components)) {
      planStatus = components.every((component) => component.status === "done") ? "completed" : "incomplete";
    }
  }
  return { cost, planStatus };
}

function failureSignature(run: AgentRunLifecycleDto, evidence: OnlineRunEvidence): string | undefined {
  if (run.outcome === "completed" && evidence.toolErrors === 0 && evidence.persistenceFailures === 0) return undefined;
  return createHash("sha256").update(JSON.stringify({
    outcome: run.outcome,
    gate: evidence.verificationGate,
    toolErrors: evidence.toolErrors,
    cadFailures: evidence.cadFailures,
    persistenceFailures: evidence.persistenceFailures,
  })).digest("hex");
}

export function recordCompletedRunMonitoring(
  db: DatabaseSync,
  run: AgentRunLifecycleDto,
  policy: OnlineSamplingPolicy = productionSamplingPolicy,
): { score: ReturnType<typeof scoreOnlineRuns>["scores"][number]; review?: ReturnType<typeof scoreOnlineRuns>["reviewInventory"][number] } | undefined {
  try {
    if (run.status !== "completed") return undefined;
    const conversation = db.prepare("SELECT last_gate_status FROM conversations WHERE id = ?")
      .get(run.conversationId) as { last_gate_status: string | null } | undefined;
    const diagnostics = eventDiagnostics(db, run.id);
    const messageEvidence = structuredMessageEvidence(db, run.conversationId);
    const gate = conversation?.last_gate_status === "passed" ? "passed"
      : conversation?.last_gate_status === "failed" ? "failed"
      : "unavailable";
    const evidence: OnlineRunEvidence = {
      runId: run.id,
      release: run.release,
      configuration: {
        name: run.agentConfiguration.name,
        identityHash: run.agentConfiguration.identityHash,
      },
      provider: run.agentConfiguration.provider,
      model: run.agentConfiguration.model,
      modality: observableModality(db, run.conversationId),
      lifecycleComplete: true,
      planStatus: messageEvidence.planStatus,
      verificationGate: gate,
      requiredEvidence: gate === "unavailable" ? 0 : 1,
      observedEvidence: gate === "unavailable" ? 0 : 1,
      completionClaimed: run.outcome === "completed",
      toolCalls: run.counters.toolCalls,
      toolErrors: diagnostics.toolErrors,
      cadFailures: diagnostics.cadFailures,
      retries: run.counters.retries,
      cost: messageEvidence.cost,
      latencyMs: run.totalDurationMs ?? 0,
      persistenceFailures: run.counters.persistenceFailures,
    };
    evidence.failureSignature = failureSignature(run, evidence);
    const knownReleases = (db.prepare("SELECT DISTINCT release FROM online_run_scores").all() as Array<{ release: string }>)
      .map((row) => row.release);
    const knownFailureSignatures = (db.prepare("SELECT signature FROM online_failure_signatures").all() as Array<{
      signature: string;
    }>).map((row) => row.signature);
    const scored = scoreOnlineRuns({
      runs: [evidence],
      policy,
      knownReleases,
      knownFailureSignatures,
      previouslySelectedRunIds: [],
    });
    const score = scored.scores[0]!;
    const review = scored.reviewInventory[0];
    const now = Date.now();
    db.prepare(`INSERT OR IGNORE INTO online_run_scores
      (run_id, release, agent_configuration_hash, provider, model, modality, score_provenance, score_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        run.id,
        run.release,
        run.agentConfiguration.identityHash,
        run.agentConfiguration.provider,
        run.agentConfiguration.model,
        evidence.modality,
        `online-deterministic@${policy.version}`,
        JSON.stringify(score),
        now,
      );
    if (review) {
      db.prepare(`INSERT OR IGNORE INTO online_review_inventory
        (run_id, reasons_json, sampling_policy_version, created_at) VALUES (?, ?, ?, ?)`)
        .run(run.id, JSON.stringify(review.reasons), policy.version, now);
    }
    if (evidence.failureSignature) {
      db.prepare("INSERT OR IGNORE INTO online_failure_signatures (signature, first_run_id, created_at) VALUES (?, ?, ?)")
        .run(evidence.failureSignature, run.id, now);
    }
    return { score, ...(review ? { review } : {}) };
  } catch {
    return undefined;
  }
}

export function addOnlineReviewReason(db: DatabaseSync, runId: string, reason: ReviewReason): void {
  try {
    const row = db.prepare("SELECT reasons_json, sampling_policy_version FROM online_review_inventory WHERE run_id = ?")
      .get(runId) as { reasons_json: string; sampling_policy_version: number } | undefined;
    const reasons = new Set<ReviewReason>(row ? JSON.parse(row.reasons_json) as ReviewReason[] : []);
    reasons.add(reason);
    db.prepare(`INSERT INTO online_review_inventory (run_id, reasons_json, sampling_policy_version, created_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(run_id) DO UPDATE SET reasons_json = excluded.reasons_json`)
      .run(runId, JSON.stringify([...reasons]), row?.sampling_policy_version ?? 1, Date.now());
  } catch {
    // Monitoring is best effort and cannot affect user feedback.
  }
}
