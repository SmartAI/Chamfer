import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  FusionFailureClass, FusionRecoveryDto, FusionRecoveryOperation, FusionRecoveryState,
} from "@chamfer/shared";
import { fusionLedgerActionIdentity } from "./actionLedger";

interface RecoveryRow {
  id: string;
  conversation_id: string;
  state: FusionRecoveryState;
  failure_class: FusionFailureClass;
  diagnosis: string;
  allowed_operation: FusionRecoveryOperation;
  preceding_revision: string;
  observed_revision: string | null;
  evidence_ids_json: string;
  recorded_at: number;
}

function parse(row: RecoveryRow): FusionRecoveryDto {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    state: row.state,
    failureClass: row.failure_class,
    diagnosis: row.diagnosis,
    allowedOperation: row.allowed_operation,
    precedingRevision: row.preceding_revision,
    ...(row.observed_revision ? { observedRevision: row.observed_revision } : {}),
    evidenceIds: JSON.parse(row.evidence_ids_json) as string[],
    recordedAt: row.recorded_at,
  };
}

export function appendFusionRecovery(
  db: DatabaseSync,
  input: {
    conversationId: string;
    endpoint: string;
    actionId: string;
    state: FusionRecoveryState;
    failureClass: FusionFailureClass;
    diagnosis: string;
    allowedOperation: FusionRecoveryOperation;
    precedingRevision: string;
    observedRevision?: string;
    evidenceIds?: string[];
  },
  now = Date.now(),
): FusionRecoveryDto {
  const id = randomUUID();
  db.prepare(`INSERT INTO fusion_recovery_ledger
    (id, conversation_id, endpoint, action_id, state, failure_class, diagnosis, allowed_operation,
     preceding_revision, observed_revision, evidence_ids_json, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, input.conversationId, input.endpoint, fusionLedgerActionIdentity(input.actionId), input.state,
      input.failureClass, input.diagnosis, input.allowedOperation, input.precedingRevision,
      input.observedRevision ?? null, JSON.stringify(input.evidenceIds ?? []), now,
    );
  return parse(db.prepare("SELECT * FROM fusion_recovery_ledger WHERE id = ?").get(id) as unknown as RecoveryRow);
}

export function currentFusionRecovery(db: DatabaseSync, endpoint: string): FusionRecoveryDto | undefined {
  const row = db.prepare(`SELECT * FROM fusion_recovery_ledger
    WHERE endpoint = ? ORDER BY recorded_at DESC, rowid DESC LIMIT 1`).get(endpoint) as unknown as RecoveryRow | undefined;
  if (!row || row.state === "resolved") return undefined;
  return parse(row);
}

/** Releases unresolved endpoint recoveries owned by a conversation that is being
 * deleted. Recovery is normally resolved by the owning conversation's trusted
 * inspection, but a deleted conversation can never do that, so without this
 * release the endpoint would stay blocked forever. Releasing is safe: any new
 * conversation must establish fresh trusted inspection evidence before it can
 * mutate. The ledger is append-only, so the release is a `resolved` row. */
export function releaseFusionRecoveriesOwnedByConversation(
  db: DatabaseSync,
  conversationId: string,
  now = Date.now(),
): void {
  const endpoints = db.prepare(
    "SELECT DISTINCT endpoint FROM fusion_recovery_ledger WHERE conversation_id = ?",
  ).all(conversationId) as Array<{ endpoint: string }>;
  for (const { endpoint } of endpoints) {
    const unresolved = currentFusionRecovery(db, endpoint);
    if (!unresolved || unresolved.conversationId !== conversationId) continue;
    appendFusionRecovery(db, {
      conversationId,
      endpoint,
      actionId: "conversation-deleted",
      state: "resolved",
      failureClass: unresolved.failureClass,
      diagnosis: "The conversation owning this recovery was deleted; the endpoint block is released. A new conversation must establish fresh trusted inspection evidence before mutation.",
      allowedOperation: "none",
      precedingRevision: unresolved.precedingRevision,
      ...(unresolved.observedRevision ? { observedRevision: unresolved.observedRevision } : {}),
    }, now);
  }
}
