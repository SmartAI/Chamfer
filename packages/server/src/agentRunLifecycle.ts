import type { DatabaseSync } from "node:sqlite";
import {
  AGENT_RUN_LIFECYCLE_VERSION,
  type AgentConfigurationTraceIdentity,
  type AgentRunCounters,
  type AgentRunDurations,
  type AgentRunEvaluationIdentity,
  type AgentRunLifecycleDto,
  type AgentRunLifecycleEvent,
  type AgentRunOutcome,
} from "@chamfer/shared";
import { ConversationEventStore } from "./conversationEventStore";
import { withImmediateTransaction } from "./dbTransaction";

const MAX_EVENTS_PER_RUN = 512;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const SHA256 = /^[a-f0-9]{64}$/;
interface AgentRunRow {
  id: string;
  conversation_id: string;
  status: "running" | "completed";
  outcome: AgentRunOutcome | null;
  started_at: number;
  completed_at: number | null;
  total_duration_ms: number | null;
  release: string;
  agent_configuration_json: string;
  evaluation_json: string | null;
  last_seq: number;
  counters_json: string;
  durations_json: string;
}

interface StoredEventRow {
  event_json: string;
}

export class AgentRunLifecycleError extends Error {
  constructor(message: string, readonly code: "invalid" | "not-found" | "conflict" | "ownership") {
    super(message);
  }
}

const emptyCounters = (): AgentRunCounters => ({
  modelCalls: 0,
  toolCalls: 0,
  cadRuns: 0,
  retries: 0,
  compactions: 0,
  persistenceFailures: 0,
  searches: 0,
  skillLoads: 0,
});

const emptyDurations = (): AgentRunDurations => ({
  modelMs: 0,
  toolMs: 0,
  cadMs: 0,
  compactionMs: 0,
  persistenceMs: 0,
  retryDelayMs: 0,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeId(value: unknown, label: string): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new AgentRunLifecycleError(`${label} must be a bounded safe identifier`, "invalid");
  }
  return value;
}

function safeInteger(value: unknown, label: string, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) {
    throw new AgentRunLifecycleError(`${label} must be a non-negative safe integer`, "invalid");
  }
  return value as number;
}

function normalizeConfiguration(value: unknown): AgentConfigurationTraceIdentity {
  if (!isRecord(value) || typeof value.identityHash !== "string" || !SHA256.test(value.identityHash)) {
    throw new AgentRunLifecycleError("agent configuration identityHash must be a lowercase SHA-256", "invalid");
  }
  return {
    name: safeId(value.name, "agent configuration name"),
    identityHash: value.identityHash,
    provider: safeId(value.provider, "provider"),
    model: safeId(value.model, "model"),
  };
}

function normalizeEvaluation(value: unknown): AgentRunEvaluationIdentity | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new AgentRunLifecycleError("evaluation identity must be an object", "invalid");
  return {
    caseExecutionId: safeId(value.caseExecutionId, "caseExecutionId"),
    caseId: safeId(value.caseId, "caseId"),
    corpusVersion: safeId(value.corpusVersion, "corpusVersion"),
    repetition: safeInteger(value.repetition, "repetition", 10_000),
  };
}

function eventKeys(event: Record<string, unknown>): Set<string> {
  return new Set(Object.keys(event));
}

function requireOnly(event: Record<string, unknown>, allowed: readonly string[]): void {
  const keys = eventKeys(event);
  for (const key of keys) {
    if (!allowed.includes(key)) throw new AgentRunLifecycleError(`unexpected lifecycle field: ${key}`, "invalid");
  }
}

/** Rejects arbitrary payloads and returns the small canonical lifecycle shape persisted by the server. */
export function normalizeAgentRunEvent(value: unknown, expectedRunId: string): AgentRunLifecycleEvent {
  if (!isRecord(value)) throw new AgentRunLifecycleError("lifecycle event must be an object", "invalid");
  if (value.version !== AGENT_RUN_LIFECYCLE_VERSION) {
    throw new AgentRunLifecycleError("unsupported lifecycle version", "invalid");
  }
  const runId = safeId(value.runId, "runId");
  if (runId !== expectedRunId) throw new AgentRunLifecycleError("event runId does not match route", "ownership");
  const base = {
    version: AGENT_RUN_LIFECYCLE_VERSION,
    runId,
    seq: safeInteger(value.seq, "seq", MAX_EVENTS_PER_RUN - 1),
    timestamp: safeInteger(value.timestamp, "timestamp"),
  } as const;
  switch (value.type) {
    case "run.started": {
      requireOnly(value, ["version", "runId", "seq", "timestamp", "type", "agentConfiguration", "evaluation"]);
      if (base.seq !== 0) throw new AgentRunLifecycleError("run.started must have seq 0", "invalid");
      const evaluation = normalizeEvaluation(value.evaluation);
      return {
        ...base,
        type: "run.started",
        agentConfiguration: normalizeConfiguration(value.agentConfiguration),
        ...(evaluation ? { evaluation } : {}),
      };
    }
    case "turn.started":
    case "compaction.started": {
      requireOnly(value, ["version", "runId", "seq", "timestamp", "type", "operationId"]);
      return { ...base, type: value.type, operationId: safeId(value.operationId, "operationId") };
    }
    case "tool.started": {
      requireOnly(value, ["version", "runId", "seq", "timestamp", "type", "operationId", "name"]);
      const name = safeId(value.name, "tool name");
      return { ...base, type: value.type, operationId: safeId(value.operationId, "operationId"), name };
    }
    case "turn.completed":
    case "tool.completed":
    case "compaction.completed": {
      requireOnly(value, ["version", "runId", "seq", "timestamp", "type", "operationId", "outcome", "durationMs"]);
      if (value.outcome !== "ok" && value.outcome !== "error" && value.outcome !== "aborted") {
        throw new AgentRunLifecycleError("invalid operation outcome", "invalid");
      }
      return {
        ...base,
        type: value.type,
        operationId: safeId(value.operationId, "operationId"),
        outcome: value.outcome,
        durationMs: safeInteger(value.durationMs, "durationMs", 86_400_000),
      };
    }
    case "retry.recorded":
      requireOnly(value, ["version", "runId", "seq", "timestamp", "type", "attempt", "delayMs"]);
      return {
        ...base,
        type: value.type,
        attempt: safeInteger(value.attempt, "attempt", 100),
        delayMs: safeInteger(value.delayMs, "delayMs", 300_000),
      };
    case "persistence.completed":
    case "persistence.failed":
      requireOnly(value, ["version", "runId", "seq", "timestamp", "type", "operationId", "durationMs"]);
      return {
        ...base,
        type: value.type,
        operationId: safeId(value.operationId, "operationId"),
        durationMs: safeInteger(value.durationMs, "durationMs", 300_000),
      };
    case "run.completed": {
      requireOnly(value, ["version", "runId", "seq", "timestamp", "type", "outcome", "durationMs"]);
      const outcomes: AgentRunOutcome[] = ["completed", "blocked", "escalated", "failed", "aborted", "incomplete"];
      if (!outcomes.includes(value.outcome as AgentRunOutcome)) {
        throw new AgentRunLifecycleError("invalid run outcome", "invalid");
      }
      return {
        ...base,
        type: value.type,
        outcome: value.outcome as AgentRunOutcome,
        durationMs: safeInteger(value.durationMs, "durationMs", 86_400_000),
      };
    }
    default:
      throw new AgentRunLifecycleError("unknown lifecycle event type", "invalid");
  }
}

function toDto(row: AgentRunRow): AgentRunLifecycleDto {
  const evaluation = row.evaluation_json
    ? JSON.parse(row.evaluation_json) as AgentRunEvaluationIdentity
    : undefined;
  return {
    version: AGENT_RUN_LIFECYCLE_VERSION,
    id: row.id,
    conversationId: row.conversation_id,
    status: row.status,
    ...(row.outcome ? { outcome: row.outcome } : {}),
    startedAt: row.started_at,
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
    ...(row.total_duration_ms === null ? {} : { totalDurationMs: row.total_duration_ms }),
    release: row.release,
    agentConfiguration: JSON.parse(row.agent_configuration_json) as AgentConfigurationTraceIdentity,
    ...(evaluation ? { evaluation } : {}),
    lastSeq: row.last_seq,
    counters: JSON.parse(row.counters_json) as AgentRunCounters,
    durations: JSON.parse(row.durations_json) as AgentRunDurations,
  };
}

function operationStarts(db: DatabaseSync, runId: string): Map<string, AgentRunLifecycleEvent> {
  const rows = db.prepare("SELECT event_json FROM agent_run_events WHERE run_id = ? ORDER BY seq ASC").all(runId) as unknown as StoredEventRow[];
  const open = new Map<string, AgentRunLifecycleEvent>();
  for (const row of rows) {
    const event = JSON.parse(row.event_json) as AgentRunLifecycleEvent;
    if (event.type === "turn.started" || event.type === "tool.started" || event.type === "compaction.started") {
      open.set(event.operationId, event);
    }
    if (event.type === "turn.completed" || event.type === "tool.completed" || event.type === "compaction.completed") {
      open.delete(event.operationId);
    }
  }
  return open;
}

function applyEvent(
  counters: AgentRunCounters,
  durations: AgentRunDurations,
  open: Map<string, AgentRunLifecycleEvent>,
  event: AgentRunLifecycleEvent,
): void {
  if (event.type === "turn.started" || event.type === "tool.started" || event.type === "compaction.started") {
    if (open.has(event.operationId)) throw new AgentRunLifecycleError("operationId is already open", "conflict");
    open.set(event.operationId, event);
    if (event.type === "turn.started") counters.modelCalls += 1;
    if (event.type === "compaction.started") counters.compactions += 1;
    if (event.type === "tool.started") {
      counters.toolCalls += 1;
      if (event.name === "execute_cad_change") counters.cadRuns += 1;
      if (event.name === "lookup_docs") counters.searches += 1;
    }
    return;
  }
  if (event.type === "turn.completed" || event.type === "tool.completed" || event.type === "compaction.completed") {
    const start = open.get(event.operationId);
    const expected = event.type.replace(".completed", ".started");
    if (!start || start.type !== expected) throw new AgentRunLifecycleError("operation completion has no matching start", "conflict");
    open.delete(event.operationId);
    if (event.type === "turn.completed") durations.modelMs += event.durationMs;
    if (event.type === "compaction.completed") durations.compactionMs += event.durationMs;
    if (event.type === "tool.completed") {
      durations.toolMs += event.durationMs;
      if (start.type === "tool.started" && start.name === "execute_cad_change") durations.cadMs += event.durationMs;
    }
    return;
  }
  if (event.type === "retry.recorded") {
    counters.retries += 1;
    durations.retryDelayMs += event.delayMs;
  } else if (event.type === "persistence.completed" || event.type === "persistence.failed") {
    durations.persistenceMs += event.durationMs;
    if (event.type === "persistence.failed") counters.persistenceFailures += 1;
  }
}

export function getAgentRun(db: DatabaseSync, conversationId: string, runId: string): AgentRunLifecycleDto | undefined {
  const row = db.prepare("SELECT * FROM agent_runs WHERE id = ? AND conversation_id = ?").get(runId, conversationId) as unknown as AgentRunRow | undefined;
  return row ? toDto(row) : undefined;
}

export function getLatestAgentRun(db: DatabaseSync, conversationId: string): AgentRunLifecycleDto | undefined {
  const row = db.prepare("SELECT * FROM agent_runs WHERE conversation_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1")
    .get(conversationId) as unknown as AgentRunRow | undefined;
  return row ? toDto(row) : undefined;
}

export function storeAgentRunTraceReference(
  db: DatabaseSync,
  runId: string,
  reference: { traceId: string; observationId: string },
): void {
  db.prepare(`INSERT INTO agent_run_trace_refs (run_id, trace_id, observation_id) VALUES (?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET trace_id = excluded.trace_id, observation_id = excluded.observation_id`)
    .run(runId, reference.traceId, reference.observationId);
}

export function ingestAgentRunEvents(
  db: DatabaseSync,
  conversationId: string,
  runId: string,
  rawEvents: unknown[],
  release: string,
  onEvent?: (run: AgentRunLifecycleDto, event: AgentRunLifecycleEvent) => void,
  recordConversationEvents = true,
): AgentRunLifecycleDto {
  if (rawEvents.length === 0 || rawEvents.length > 32) {
    throw new AgentRunLifecycleError("event batch must contain 1 to 32 events", "invalid");
  }
  const events = rawEvents.map((event) => normalizeAgentRunEvent(event, runId));
  let row = db.prepare("SELECT * FROM agent_runs WHERE id = ?").get(runId) as unknown as AgentRunRow | undefined;
  if (row && row.conversation_id !== conversationId) {
    throw new AgentRunLifecycleError("agent run belongs to another conversation", "ownership");
  }
  if (!row && events[0]?.type !== "run.started") {
    throw new AgentRunLifecycleError("first event must start the run", "conflict");
  }

  const newEvents: AgentRunLifecycleEvent[] = [];
  withImmediateTransaction(db, () => {
    if (!row) {
      const started = events[0] as Extract<AgentRunLifecycleEvent, { type: "run.started" }>;
      const counters = emptyCounters();
      const durations = emptyDurations();
      db.prepare(`INSERT INTO agent_runs
        (id, conversation_id, status, started_at, release, agent_configuration_json, evaluation_json,
         last_seq, counters_json, durations_json)
        VALUES (?, ?, 'running', ?, ?, ?, ?, -1, ?, ?)`)
        .run(
          runId,
          conversationId,
          started.timestamp,
          release,
          JSON.stringify(started.agentConfiguration),
          started.evaluation ? JSON.stringify(started.evaluation) : null,
          JSON.stringify(counters),
          JSON.stringify(durations),
        );
      row = db.prepare("SELECT * FROM agent_runs WHERE id = ?").get(runId) as unknown as AgentRunRow;
    }
    const counters = JSON.parse(row.counters_json) as AgentRunCounters;
    const durations = JSON.parse(row.durations_json) as AgentRunDurations;
    const open = operationStarts(db, runId);
    let lastSeq = row.last_seq;
    let lastTimestamp = lastSeq >= 0
      ? (JSON.parse((db.prepare("SELECT event_json FROM agent_run_events WHERE run_id = ? AND seq = ?").get(runId, lastSeq) as unknown as StoredEventRow).event_json) as AgentRunLifecycleEvent).timestamp
      : -1;
    let status = row.status;
    let outcome = row.outcome;
    let completedAt = row.completed_at;
    let totalDurationMs = row.total_duration_ms;
    for (const event of events) {
      const canonical = JSON.stringify(event);
      if (event.seq <= lastSeq) {
        const existing = db.prepare("SELECT event_json FROM agent_run_events WHERE run_id = ? AND seq = ?").get(runId, event.seq) as unknown as StoredEventRow | undefined;
        if (existing?.event_json === canonical) continue;
        throw new AgentRunLifecycleError("event sequence conflicts with stored lifecycle", "conflict");
      }
      if (status === "completed") throw new AgentRunLifecycleError("completed agent run is immutable", "conflict");
      if (event.seq !== lastSeq + 1) throw new AgentRunLifecycleError("lifecycle events must be contiguous", "conflict");
      if (event.timestamp < lastTimestamp) throw new AgentRunLifecycleError("lifecycle timestamps must be ordered", "conflict");
      if (event.type === "run.started" && event.seq !== 0) throw new AgentRunLifecycleError("run can only start once", "conflict");
      applyEvent(counters, durations, open, event);
      if (event.type === "run.completed") {
        status = "completed";
        outcome = event.outcome;
        completedAt = event.timestamp;
        totalDurationMs = event.durationMs;
      }
      if (recordConversationEvents) {
        new ConversationEventStore(db).append(conversationId, {
          recordedAt: event.timestamp,
          type: "agent-run.lifecycle-recorded",
          data: { event, release },
        });
      }
      db.prepare("INSERT INTO agent_run_events (run_id, seq, event_json) VALUES (?, ?, ?)").run(runId, event.seq, canonical);
      lastSeq = event.seq;
      lastTimestamp = event.timestamp;
      newEvents.push(event);
    }
    db.prepare(`UPDATE agent_runs SET status = ?, outcome = ?, completed_at = ?, total_duration_ms = ?,
      last_seq = ?, counters_json = ?, durations_json = ? WHERE id = ?`)
      .run(status, outcome, completedAt, totalDurationMs, lastSeq, JSON.stringify(counters), JSON.stringify(durations), runId);
  });
  const run = getAgentRun(db, conversationId, runId)!;
  if (onEvent) {
    for (const event of newEvents) {
      try {
        onEvent(run, event);
      } catch {
        // Observability export is best effort and must never affect durable ingestion.
      }
    }
  }
  return run;
}
