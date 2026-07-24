import type { DatabaseSync } from "node:sqlite";
import {
  CONVERSATION_EVENT_SCHEMA_VERSION,
  advanceConversationProjection,
  projectConversationEvents,
  upcastConversationEvent,
  type ConversationArtifactRecord,
  type ConversationAttachmentRecord,
  type ConversationEvent,
  type ConversationEventDraft,
  type ConversationProjection,
} from "@chamfer/shared";
import { withImmediateTransaction } from "./dbTransaction";

// Conversation events carry references (artifact ids, blob paths, evidence
// ids), never bulk payloads; the log and its projections must stay readable
// in one bounded response no matter how long a run gets.
export const MAX_CONVERSATION_EVENT_BYTES = 1_000_000;

/** Thrown by append() when a single event exceeds the byte cap. Typed so the
 * transcript persistence layer can distinguish "this one row is too big"
 * (degrade it and keep the turn) from a genuine store failure (propagate). */
export class ConversationEventTooLargeError extends Error {
  constructor(readonly type: string, readonly byteSize: number) {
    super(
      `conversation event ${type} is ${byteSize} bytes, over the ` +
      `${MAX_CONVERSATION_EVENT_BYTES}-byte limit; store bulky content in the ` +
      "artifact, attachment, or evidence stores and reference it by id",
    );
    this.name = "ConversationEventTooLargeError";
  }
}
import { ingestAgentRunEvents } from "./agentRunLifecycle";
import { IncrementalProjectionCache } from "./incrementalProjectionCache";

interface StoredEventRow {
  event_json: string;
}

type ConversationEventListener = (event: ConversationEvent) => void;
const listenersByDatabase = new WeakMap<object, Map<string, Set<ConversationEventListener>>>();
const projectionsByDatabase = new WeakMap<object, IncrementalProjectionCache<ConversationEvent, ConversationProjection>>();

function databaseProjections(db: DatabaseSync): IncrementalProjectionCache<ConversationEvent, ConversationProjection> {
  const existing = projectionsByDatabase.get(db as object);
  if (existing) return existing;
  const created = new IncrementalProjectionCache(
    (projection: ConversationProjection) => projection.lastSequence,
    advanceConversationProjection,
  );
  projectionsByDatabase.set(db as object, created);
  return created;
}

export function invalidateConversationProjection(db: DatabaseSync, conversationId: string): void {
  projectionsByDatabase.get(db as object)?.invalidate(conversationId);
}

function databaseListeners(db: DatabaseSync): Map<string, Set<ConversationEventListener>> {
  const existing = listenersByDatabase.get(db as object);
  if (existing) return existing;
  const created = new Map<string, Set<ConversationEventListener>>();
  listenersByDatabase.set(db as object, created);
  return created;
}

interface LegacyConversationRow {
  id: string;
  title: string;
  design_id: string | null;
  cad_environment: "build123d" | "fusion";
  created_at: number;
  source_specifications_required: number;
}

function gateStatus(role: string, contentJson: string): string | undefined {
  if (role !== "toolResult") return undefined;
  try {
    const status = (JSON.parse(contentJson) as { details?: { gate?: { status?: unknown } } }).details?.gate?.status;
    return status === "passed" || status === "failed" || status === "error" ? status : undefined;
  } catch {
    return undefined;
  }
}

function assertDraftIdentity(db: DatabaseSync, conversationId: string, draft: ConversationEventDraft): void {
  if (draft.type === "message.appended") {
    if (draft.data.message.conversationId !== conversationId) {
      throw new Error("message conversation identity does not match event stream");
    }
    if (draft.data.attachments.some((attachment) => attachment.messageId !== draft.data.message.id)) {
      throw new Error("attachment message identity does not match appended message");
    }
  }
  if (draft.type === "attachment.appended") {
    const owner = db.prepare(`SELECT m.conversation_id AS conversationId FROM messages m
      WHERE m.id = ?`).get(draft.data.attachment.messageId) as { conversationId: string } | undefined;
    if (owner?.conversationId !== conversationId) {
      throw new Error("attachment message does not belong to event stream");
    }
  }
  if (draft.type === "artifact.stored" && draft.data.artifact.conversationId !== conversationId) {
    throw new Error("artifact conversation identity does not match event stream");
  }
  if (draft.type === "agent-run.lifecycle-recorded" && draft.data.event.runId.length === 0) {
    throw new Error("agent run identity is required");
  }
  if (draft.type === "headless-run.recorded" && draft.data.event.type === "run" &&
      draft.data.event.run.id !== draft.data.runId) {
    throw new Error("headless run identity does not match recorded event");
  }
}

function applyProjectionEvent(db: DatabaseSync, event: ConversationEvent, rebuilding = false): void {
  switch (event.type) {
    case "conversation.created":
      db.prepare(`${rebuilding ? "INSERT OR IGNORE" : "INSERT"} INTO conversations
        (id, title, design_id, cad_environment, created_at, updated_at, source_specifications_required)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(
          event.conversationId,
          event.data.title,
          event.data.designId,
          event.data.cadEnvironment,
          event.recordedAt,
          event.recordedAt,
          event.data.sourceSpecificationsRequired ? 1 : 0,
        );
      if (rebuilding) {
        db.prepare(`UPDATE conversations SET title = ?, design_id = ?, cad_environment = ?,
          created_at = ?, updated_at = ?, source_specifications_required = ?, last_gate_status = NULL
          WHERE id = ?`)
          .run(
            event.data.title,
            event.data.designId,
            event.data.cadEnvironment,
            event.recordedAt,
            event.recordedAt,
            event.data.sourceSpecificationsRequired ? 1 : 0,
            event.conversationId,
          );
      }
      break;
    case "conversation.title-updated":
      db.prepare("UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?")
        .run(event.data.title, event.recordedAt, event.conversationId);
      break;
    case "conversation.design-detached":
      db.prepare("UPDATE conversations SET design_id = NULL, updated_at = ? WHERE id = ? AND design_id = ?")
        .run(event.recordedAt, event.conversationId, event.data.designId);
      break;
    case "message.appended": {
      const message = event.data.message;
      db.prepare(`INSERT INTO messages
        (id, conversation_id, seq, role, content_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(message.id, event.conversationId, message.seq, message.role, message.contentJson, message.createdAt);
      for (const attachment of event.data.attachments) {
        db.prepare(`INSERT INTO attachments
          (id, message_id, kind, mime, content_hash, byte_size, blob_path, display_order)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(
            attachment.id,
            message.id,
            attachment.kind,
            attachment.mime,
            attachment.contentHash,
            attachment.byteSize,
            attachment.blobPath,
            attachment.displayOrder,
          );
      }
      db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?")
        .run(event.recordedAt, event.conversationId);
      const status = gateStatus(message.role, message.contentJson);
      if (status) db.prepare("UPDATE conversations SET last_gate_status = ? WHERE id = ?")
        .run(status, event.conversationId);
      break;
    }
    case "attachment.appended": {
      const attachment = event.data.attachment;
      db.prepare(`INSERT INTO attachments
        (id, message_id, kind, mime, content_hash, byte_size, blob_path, display_order)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          attachment.id,
          attachment.messageId,
          attachment.kind,
          attachment.mime,
          attachment.contentHash,
          attachment.byteSize,
          attachment.blobPath,
          attachment.displayOrder,
        );
      break;
    }
    case "artifact.stored": {
      const artifact = event.data.artifact;
      db.prepare(`INSERT INTO artifacts
        (id, conversation_id, version, py_source, params_json, gate_json, measurements_json, created_at)
        VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)
        ${rebuilding ? `ON CONFLICT(id) DO UPDATE SET conversation_id = excluded.conversation_id,
          version = excluded.version, py_source = excluded.py_source, params_json = excluded.params_json,
          gate_json = NULL, measurements_json = NULL, created_at = excluded.created_at` : ""}`)
        .run(
          artifact.id,
          event.conversationId,
          artifact.version,
          artifact.pySource,
          artifact.paramsJson,
          artifact.createdAt,
        );
      break;
    }
    case "evidence.linked":
      db.prepare(`INSERT OR IGNORE INTO conversation_evidence_links
        (conversation_id, evidence_id, relationship, sequence) VALUES (?, ?, ?, ?)`)
        .run(event.conversationId, event.data.evidenceId, event.data.relationship, event.sequence);
      db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?")
        .run(event.recordedAt, event.conversationId);
      break;
    case "ui.state-updated":
      db.prepare(`INSERT INTO conversation_ui_projection (conversation_id, key, value_json, sequence)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(conversation_id, key) DO UPDATE SET
          value_json = excluded.value_json, sequence = excluded.sequence`)
        .run(event.conversationId, event.data.key, JSON.stringify(event.data.value), event.sequence);
      break;
    case "agent-run.lifecycle-recorded":
    case "headless-run.recorded":
      // Their existing compatibility projections are maintained by the
      // lifecycle adapters after this canonical append succeeds.
      break;
  }
}

export class ConversationEventStore {
  constructor(private readonly db: DatabaseSync) {}

  append(conversationId: string, draft: ConversationEventDraft): ConversationEvent {
    const event = withImmediateTransaction(this.db, () => {
      assertDraftIdentity(this.db, conversationId, draft);
      const row = this.db.prepare(
        "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM conversation_events WHERE conversation_id = ?",
      ).get(conversationId) as { sequence: number };
      const event = {
        ...draft,
        schemaVersion: CONVERSATION_EVENT_SCHEMA_VERSION,
        id: draft.id ?? crypto.randomUUID(),
        conversationId,
        sequence: row.sequence + 1,
        recordedAt: draft.recordedAt ?? Date.now(),
      } as ConversationEvent;
      const eventJson = JSON.stringify(event);
      if (eventJson.length > MAX_CONVERSATION_EVENT_BYTES) {
        throw new ConversationEventTooLargeError(event.type, eventJson.length);
      }
      this.db.prepare(`INSERT INTO conversation_events
        (id, conversation_id, sequence, schema_version, type, event_json, recorded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(
          event.id,
          conversationId,
          event.sequence,
          event.schemaVersion,
          event.type,
          eventJson,
          event.recordedAt,
        );
      applyProjectionEvent(this.db, event);
      return event;
    });
    // All compatibility callers finish their synchronous transaction before
    // microtasks run. Rechecking durability prevents a rolled-back outer write
    // from leaking onto the live stream.
    queueMicrotask(() => {
      try {
        const persisted = this.db.prepare("SELECT 1 FROM conversation_events WHERE id = ?").get(event.id);
        if (!persisted) return;
        for (const listener of databaseListeners(this.db).get(conversationId) ?? []) listener(event);
      } catch (error) {
        if (error instanceof Error && error.message === "database is not open") return;
        throw error;
      }
    });
    return event;
  }

  events(conversationId: string, after = 0): ConversationEvent[] {
    const rows = this.db.prepare(`SELECT event_json FROM conversation_events
      WHERE conversation_id = ? AND sequence > ? ORDER BY sequence`)
      .all(conversationId, after) as unknown as StoredEventRow[];
    return rows.map((row) => upcastConversationEvent(JSON.parse(row.event_json)));
  }

  project(conversationId: string): ConversationProjection {
    if (this.db.isTransaction) return projectConversationEvents(this.events(conversationId));
    return databaseProjections(this.db).project(
      conversationId,
      (after) => this.events(conversationId, after),
    );
  }

  subscribe(conversationId: string, listener: ConversationEventListener): () => void {
    const listeners = databaseListeners(this.db);
    const current = listeners.get(conversationId) ?? new Set<ConversationEventListener>();
    current.add(listener);
    listeners.set(conversationId, current);
    return () => {
      current.delete(listener);
      if (current.size === 0) listeners.delete(conversationId);
    };
  }

  subscriberCount(conversationId: string): number {
    return databaseListeners(this.db).get(conversationId)?.size ?? 0;
  }
}

function legacyAttachments(db: DatabaseSync, messageId: string): ConversationAttachmentRecord[] {
  const hasInlineData = (db.prepare("PRAGMA table_info(attachments)").all() as Array<{ name: string }>)
    .some((column) => column.name === "data");
  return db.prepare(`SELECT id, message_id AS messageId, kind, mime,
      COALESCE(content_hash, '') AS contentHash,
      COALESCE(byte_size, ${hasInlineData ? "length(data)," : ""} 0) AS byteSize,
      COALESCE(blob_path, '') AS blobPath,
      COALESCE(display_order, rowid - 1) AS displayOrder
    FROM attachments WHERE message_id = ? ORDER BY display_order, rowid`)
    .all(messageId) as unknown as ConversationAttachmentRecord[];
}

/**
 * One-time legacy cutover.
 *
 * Existing table answers are translated into a plausible ordered log without
 * rewriting those answers. Evidence events contribute identity links only,
 * never copied payloads. The same SQL and JSON run on node:sqlite and Durable
 * Object SQLite.
 */
export function migrateConversationEventLog(db: DatabaseSync): void {
  const conversations = db.prepare("SELECT * FROM conversations ORDER BY created_at, rowid")
    .all() as unknown as LegacyConversationRow[];
  for (const conversation of conversations) {
    const existing = db.prepare("SELECT 1 FROM conversation_events WHERE conversation_id = ? LIMIT 1")
      .get(conversation.id);
    if (existing) continue;
    const drafts: Array<ConversationEventDraft & { recordedAt: number }> = [{
      id: `legacy:${conversation.id}:created`,
      recordedAt: conversation.created_at,
      type: "conversation.created",
      data: {
        title: conversation.title,
        cadEnvironment: conversation.cad_environment,
        designId: conversation.design_id,
        sourceSpecificationsRequired: conversation.source_specifications_required === 1,
      },
    }];
    const messages = db.prepare(`SELECT id, conversation_id AS conversationId, seq, role,
        content_json AS contentJson, created_at AS createdAt
      FROM messages WHERE conversation_id = ? ORDER BY seq`)
      .all(conversation.id) as Array<{
        id: string;
        conversationId: string;
        seq: number;
        role: string;
        contentJson: string;
        createdAt: number;
      }>;
    for (const message of messages) drafts.push({
      id: `legacy:${conversation.id}:message:${message.id}`,
      recordedAt: message.createdAt,
      type: "message.appended",
      data: { message, attachments: legacyAttachments(db, message.id) },
    });
    const artifacts = db.prepare(`SELECT id, conversation_id AS conversationId, version,
        py_source AS pySource, params_json AS paramsJson, created_at AS createdAt
      FROM artifacts WHERE conversation_id = ? ORDER BY version`)
      .all(conversation.id) as unknown as ConversationArtifactRecord[];
    for (const artifact of artifacts) drafts.push({
      id: `legacy:${conversation.id}:artifact:${artifact.id}`,
      recordedAt: artifact.createdAt,
      type: "artifact.stored",
      data: { artifact, evidenceIds: [] },
    });
    const evidence = db.prepare(`SELECT id, type, recorded_at AS recordedAt
      FROM evidence_events WHERE conversation_id = ? ORDER BY sequence`)
      .all(conversation.id) as Array<{ id: string; type: string; recordedAt: number }>;
    for (const item of evidence) drafts.push({
      id: `legacy:${conversation.id}:evidence:${item.id}`,
      recordedAt: item.recordedAt,
      type: "evidence.linked",
      data: {
        evidenceId: item.id,
        relationship: item.type === "plan.recorded"
          ? "plan"
          : item.type === "artifact.verified"
            ? "artifact"
            : "verification",
      },
    });
    const lifecycleRows = db.prepare(`SELECT e.event_json AS eventJson, r.release
      FROM agent_run_events e JOIN agent_runs r ON r.id = e.run_id
      WHERE r.conversation_id = ? ORDER BY r.started_at, e.seq`)
      .all(conversation.id) as Array<{ eventJson: string; release: string }>;
    for (const row of lifecycleRows) {
      const event = JSON.parse(row.eventJson) as Extract<ConversationEvent, {
        type: "agent-run.lifecycle-recorded";
      }>["data"]["event"];
      drafts.push({
        id: `legacy:${conversation.id}:agent-run:${event.runId}:${event.seq}`,
        recordedAt: event.timestamp,
        type: "agent-run.lifecycle-recorded",
        data: { event, release: row.release },
      });
    }
    const headlessRows = db.prepare(`SELECT e.run_id AS runId, e.event_json AS eventJson, e.created_at AS createdAt
      FROM headless_run_events e JOIN headless_runs r ON r.id = e.run_id
      WHERE r.conversation_id = ? ORDER BY r.created_at, e.seq`)
      .all(conversation.id) as Array<{ runId: string; eventJson: string; createdAt: number }>;
    for (const row of headlessRows) drafts.push({
      id: `legacy:${conversation.id}:headless-run:${row.runId}:${JSON.parse(row.eventJson).seq as number}`,
      recordedAt: row.createdAt,
      type: "headless-run.recorded",
      data: { runId: row.runId, event: JSON.parse(row.eventJson) },
    });
    drafts.sort((left, right) => left.recordedAt - right.recordedAt || left.id!.localeCompare(right.id!));
    const createdIndex = drafts.findIndex((draft) => draft.type === "conversation.created");
    if (createdIndex > 0) drafts.unshift(...drafts.splice(createdIndex, 1));
    const synthesized = drafts.map((draft, index) => ({
      ...draft,
      schemaVersion: CONVERSATION_EVENT_SCHEMA_VERSION,
      id: draft.id!,
      conversationId: conversation.id,
      sequence: index + 1,
    } as ConversationEvent));
    const projected = projectConversationEvents(synthesized);
    const expectedAttachments = messages.flatMap((message) => legacyAttachments(db, message.id));
    const expectedEvidenceLinks = evidence.map((item) => ({
      evidenceId: item.id,
      relationship: item.type === "plan.recorded"
        ? "plan" as const
        : item.type === "artifact.verified"
          ? "artifact" as const
          : "verification" as const,
    }));
    const expectedAgentEvents = lifecycleRows.map((row) => JSON.parse(row.eventJson));
    const expectedHeadlessEvents = headlessRows.map((row) => ({
      runId: row.runId,
      event: JSON.parse(row.eventJson),
    }));
    const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
    if (!projected.conversation || projected.conversation.title !== conversation.title ||
        projected.conversation.designId !== conversation.design_id ||
        projected.conversation.cadEnvironment !== conversation.cad_environment ||
        projected.conversation.createdAt !== conversation.created_at ||
        projected.conversation.sourceSpecificationsRequired !== (conversation.source_specifications_required === 1) ||
        !same(projected.messages, messages) || !same(projected.attachments, expectedAttachments) ||
        !same(projected.artifacts, artifacts) || !same(projected.evidenceLinks, expectedEvidenceLinks) ||
        !same(projected.agentRunEvents, expectedAgentEvents) ||
        !same(projected.headlessRunEvents, expectedHeadlessEvents)) {
      throw new Error(`legacy conversation ${conversation.id} did not survive event-log projection`);
    }
    withImmediateTransaction(db, () => {
      const insert = db.prepare(`INSERT INTO conversation_events
        (id, conversation_id, sequence, schema_version, type, event_json, recorded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`);
      for (const event of synthesized) {
        insert.run(
          event.id,
          conversation.id,
          event.sequence,
          event.schemaVersion,
          event.type,
          JSON.stringify(event),
          event.recordedAt,
        );
      }
    });
  }
}

/** Re-synthesizes only untouched cutover logs after legacy image blobs and
 * inline message blocks have been normalized. Runtime-authored logs are never
 * rewritten. */
export function refreshLegacyConversationEventLogs(db: DatabaseSync): void {
  const rows = db.prepare(`SELECT conversation_id AS conversationId,
      SUM(CASE WHEN id NOT LIKE 'legacy:%' AND id NOT LIKE 'evidence-link:%' THEN 1 ELSE 0 END) AS runtimeEvents
    FROM conversation_events GROUP BY conversation_id`)
    .all() as Array<{ conversationId: string; runtimeEvents: number }>;
  withImmediateTransaction(db, () => {
    for (const row of rows) {
      if (Number(row.runtimeEvents) !== 0) continue;
      invalidateConversationProjection(db, row.conversationId);
      db.prepare("INSERT OR IGNORE INTO conversation_event_deletion_authorizations (conversation_id) VALUES (?)")
        .run(row.conversationId);
      db.prepare("DELETE FROM conversation_events WHERE conversation_id = ?").run(row.conversationId);
      db.prepare("DELETE FROM conversation_event_deletion_authorizations WHERE conversation_id = ?")
        .run(row.conversationId);
    }
    migrateConversationEventLog(db);
  });
}

export function rebuildConversationProjection(db: DatabaseSync, conversationId: string): void {
  const store = new ConversationEventStore(db);
  const events = store.events(conversationId);
  if (events.length === 0) throw new Error("conversation event log not found");
  withImmediateTransaction(db, () => {
    const agentEvents = events.filter((event) => event.type === "agent-run.lifecycle-recorded");
    const agentRunIds = [...new Set(agentEvents.map((event) => event.data.event.runId))];
    const existingAgentRuns = db.prepare("SELECT id FROM agent_runs WHERE conversation_id = ?")
      .all(conversationId) as Array<{ id: string }>;
    for (const { id } of existingAgentRuns) {
      if (agentRunIds.includes(id)) {
        const started = agentEvents.find((item) => item.data.event.runId === id && item.data.event.type === "run.started");
        if (!started || started.data.event.type !== "run.started") throw new Error(`agent run ${id} has no start event`);
        db.prepare("DELETE FROM agent_run_events WHERE run_id = ?").run(id);
        db.prepare(`UPDATE agent_runs SET status = 'running', outcome = NULL, started_at = ?, completed_at = NULL,
          total_duration_ms = NULL, release = ?, agent_configuration_json = ?, evaluation_json = ?, last_seq = -1,
          counters_json = ?, durations_json = ? WHERE id = ?`)
          .run(
            started.data.event.timestamp,
            started.data.release,
            JSON.stringify(started.data.event.agentConfiguration),
            started.data.event.evaluation ? JSON.stringify(started.data.event.evaluation) : null,
            JSON.stringify({ modelCalls: 0, toolCalls: 0, cadRuns: 0, retries: 0, compactions: 0,
              persistenceFailures: 0, searches: 0, skillLoads: 0 }),
            JSON.stringify({ modelMs: 0, toolMs: 0, cadMs: 0, compactionMs: 0,
              persistenceMs: 0, retryDelayMs: 0 }),
            id,
          );
        continue;
      }
      db.prepare("DELETE FROM online_failure_signatures WHERE first_run_id = ?").run(id);
      db.prepare("DELETE FROM online_review_queue_refs WHERE run_id = ?").run(id);
      db.prepare("DELETE FROM online_review_inventory WHERE run_id = ?").run(id);
      db.prepare("DELETE FROM online_run_scores WHERE run_id = ?").run(id);
      db.prepare("DELETE FROM agent_run_feedback WHERE run_id = ?").run(id);
      db.prepare("DELETE FROM agent_run_trace_refs WHERE run_id = ?").run(id);
      db.prepare("DELETE FROM agent_run_events WHERE run_id = ?").run(id);
      db.prepare("DELETE FROM agent_runs WHERE id = ?").run(id);
    }
    const headlessEvents = events.filter((event) => event.type === "headless-run.recorded");
    const headlessRunIds = [...new Set(headlessEvents.map((event) => event.data.runId))];
    const existingHeadlessRuns = db.prepare("SELECT id FROM headless_runs WHERE conversation_id = ?")
      .all(conversationId) as Array<{ id: string }>;
    for (const { id } of existingHeadlessRuns) {
      db.prepare("DELETE FROM headless_run_events WHERE run_id = ?").run(id);
      // headless_run_latest is canonical latest-only state (session/mesh
      // snapshots are not in the conversation log), so surviving runs keep it.
      if (headlessRunIds.includes(id)) continue;
      db.prepare("DELETE FROM headless_run_latest WHERE run_id = ?").run(id);
      db.prepare("DELETE FROM cad_gate_evidence WHERE run_id = ?").run(id);
      db.prepare("DELETE FROM agent_run_leases WHERE run_id = ?").run(id);
      db.prepare("DELETE FROM headless_runs WHERE id = ?").run(id);
    }
    db.prepare("DELETE FROM agent_run_leases WHERE conversation_id = ?").run(conversationId);
    db.prepare("DELETE FROM conversation_ui_projection WHERE conversation_id = ?").run(conversationId);
    db.prepare("DELETE FROM conversation_evidence_links WHERE conversation_id = ?").run(conversationId);
    db.prepare(`DELETE FROM attachments WHERE message_id IN
      (SELECT id FROM messages WHERE conversation_id = ?)` ).run(conversationId);
    db.prepare("DELETE FROM messages WHERE conversation_id = ?").run(conversationId);
    // Artifact identities can be referenced by the independent evidence log,
    // accepted design revisions, and proof reports. Replay updates them in
    // place instead of breaking those cross-aggregate references.
    // Keep the identity row in place because the independent evidence ledger
    // and external endpoint bindings reference it by foreign key. Its mutable
    // fields are reset by replaying conversation.created below.
    for (const event of events) applyProjectionEvent(db, event, true);
    for (const runId of agentRunIds) {
      const runEvents = agentEvents.filter((item) => item.data.event.runId === runId);
      const release = runEvents[0]!.data.release;
      for (let offset = 0; offset < runEvents.length; offset += 32) {
        ingestAgentRunEvents(
          db,
          conversationId,
          runId,
          runEvents.slice(offset, offset + 32).map((item) => item.data.event),
          release,
          undefined,
          false,
        );
      }
    }
    for (const runId of headlessRunIds) {
      const recorded = headlessEvents.filter((event) => event.data.runId === runId);
      const runStates = recorded.flatMap((event) => event.data.event.type === "run" ? [event.data.event.run] : []);
      const first = runStates[0];
      const final = runStates.at(-1);
      if (!first || !final) throw new Error(`headless run ${runId} has no state event`);
      db.prepare(`INSERT INTO headless_runs
        (id, conversation_id, status, model_name, created_at, updated_at, completed_at, resumable, last_event_seq, error)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET conversation_id = excluded.conversation_id, status = excluded.status,
          model_name = excluded.model_name, created_at = excluded.created_at, updated_at = excluded.updated_at,
          completed_at = excluded.completed_at, resumable = excluded.resumable,
          last_event_seq = excluded.last_event_seq, error = excluded.error`)
        .run(
          runId,
          conversationId,
          final.status,
          final.modelName,
          first.createdAt,
          recorded.at(-1)!.recordedAt,
          final.completedAt ?? null,
          final.resumable ? 1 : 0,
          recorded.at(-1)!.data.event.seq,
          final.error ?? null,
        );
      const insert = db.prepare(`INSERT INTO headless_run_events
        (run_id, seq, event_json, created_at) VALUES (?, ?, ?, ?)`);
      for (const item of recorded) {
        insert.run(runId, item.data.event.seq, JSON.stringify(item.data.event), item.recordedAt);
      }
    }
    // Artifact verification payloads belong exclusively to the evidence log.
    // Rebuilding the compatibility artifact projection therefore joins by
    // evidence identity instead of copying gate or measurement data into the
    // conversation log.
    const verifications = db.prepare(`SELECT data_json AS dataJson FROM evidence_events
      WHERE conversation_id = ? AND type = 'artifact.verified' ORDER BY sequence`)
      .all(conversationId) as Array<{ dataJson: string }>;
    for (const row of verifications) {
      const data = JSON.parse(row.dataJson) as {
        artifactId: string;
        artifactVersion: number;
        gate: unknown;
        measurements: unknown;
      };
      db.prepare(`UPDATE artifacts SET gate_json = ?, measurements_json = ?
        WHERE id = ? AND conversation_id = ? AND version = ?`)
        .run(
          JSON.stringify(data.gate),
          JSON.stringify(data.measurements),
          data.artifactId,
          conversationId,
          data.artifactVersion,
        );
    }
  });
}
