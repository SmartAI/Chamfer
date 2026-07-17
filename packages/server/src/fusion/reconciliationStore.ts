import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  FusionAffectedReferenceDto,
  FusionCheckResultDto,
  FusionDocumentIdentityDto,
  FusionInspectionRecordDto,
  FusionReconciliationRecordDto,
} from "@chamfer/shared";
import { reconcileFusionSnapshots } from "./reconciliation";

interface Row {
  id: string;
  conversation_id: string;
  recorded_at: number;
  document_json: string;
  preceding_revision: string;
  observed_revision: string;
  status: FusionReconciliationRecordDto["status"];
  reason: FusionReconciliationRecordDto["reason"];
  summary: string;
  changes_json: string;
  refreshed_references_json: string;
  refreshed_checks_json: string;
  evidence_id: string;
}

function parse(row: Row): FusionReconciliationRecordDto {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    recordedAt: row.recorded_at,
    document: JSON.parse(row.document_json),
    precedingRevision: row.preceding_revision,
    observedRevision: row.observed_revision,
    status: row.status,
    reason: row.reason,
    summary: row.summary,
    changes: JSON.parse(row.changes_json),
    refreshedReferences: JSON.parse(row.refreshed_references_json),
    refreshedChecks: JSON.parse(row.refreshed_checks_json),
    evidenceId: row.evidence_id,
  };
}

export function getFusionReconciliation(
  db: DatabaseSync,
  conversationId: string,
  observedRevision?: string,
): FusionReconciliationRecordDto | undefined {
  const row = observedRevision
    ? db.prepare("SELECT * FROM fusion_reconciliation_ledger WHERE conversation_id = ? AND observed_revision = ? ORDER BY recorded_at DESC, rowid DESC LIMIT 1")
      .get(conversationId, observedRevision)
    : db.prepare("SELECT * FROM fusion_reconciliation_ledger WHERE conversation_id = ? ORDER BY recorded_at DESC, rowid DESC LIMIT 1")
      .get(conversationId);
  return row ? parse(row as unknown as Row) : undefined;
}

export function recordFusionReconciliation(
  db: DatabaseSync,
  conversationId: string,
  document: FusionDocumentIdentityDto,
  preceding: FusionInspectionRecordDto,
  observed: FusionInspectionRecordDto,
  activeReferences: readonly FusionAffectedReferenceDto[],
  refreshedChecks: readonly FusionCheckResultDto[],
  now = Date.now(),
): FusionReconciliationRecordDto {
  const latest = getFusionReconciliation(db, conversationId);
  // Repeated polling of the same transition is idempotent, but a fingerprint
  // that returns after an intervening transition is a new occurrence.
  if (latest?.precedingRevision === preceding.revision && latest.observedRevision === observed.revision) return latest;
  const analysis = reconcileFusionSnapshots(preceding.snapshot, observed.snapshot, activeReferences, refreshedChecks);
  const id = randomUUID();
  db.prepare(`INSERT INTO fusion_reconciliation_ledger
    (id, conversation_id, recorded_at, document_json, preceding_revision, observed_revision, status, reason,
     summary, changes_json, refreshed_references_json, refreshed_checks_json, evidence_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, conversationId, now, JSON.stringify(document), preceding.revision, observed.revision, analysis.status,
      analysis.reason, analysis.summary, JSON.stringify(analysis.changes), JSON.stringify(analysis.refreshedReferences),
      JSON.stringify(refreshedChecks), observed.id);
  return getFusionReconciliation(db, conversationId, observed.revision)!;
}

export function getFusionReconciliationResolution(db: DatabaseSync, reconciliationId: string): {
  id: string; userMessageId: string; expectedRevision?: string; intent?: string; affectedReferences?: FusionAffectedReferenceDto[];
} | undefined {
  const row = db.prepare(`SELECT id, user_message_id AS userMessageId, expected_revision AS expectedRevision,
    intent, affected_references_json AS affectedReferencesJson FROM fusion_reconciliation_resolutions WHERE reconciliation_id = ?`)
    .get(reconciliationId) as { id: string; userMessageId: string; expectedRevision?: string; intent?: string; affectedReferencesJson?: string } | undefined;
  return row ? { id: row.id, userMessageId: row.userMessageId, ...(row.expectedRevision ? { expectedRevision: row.expectedRevision } : {}),
    ...(row.intent ? { intent: row.intent } : {}), ...(row.affectedReferencesJson ? { affectedReferences: JSON.parse(row.affectedReferencesJson) } : {}) } : undefined;
}

export function recordFusionReconciliationResolution(
  db: DatabaseSync,
  reconciliation: FusionReconciliationRecordDto,
  userMessageId: string,
  expectedRevision: string,
  intent: string,
  affectedReferences: readonly FusionAffectedReferenceDto[],
  now = Date.now(),
): { id: string; userMessageId: string; expectedRevision?: string; intent?: string; affectedReferences?: FusionAffectedReferenceDto[] } {
  const existing = getFusionReconciliationResolution(db, reconciliation.id);
  if (existing) return existing;
  const id = randomUUID();
  db.prepare(`INSERT INTO fusion_reconciliation_resolutions
    (id, reconciliation_id, conversation_id, user_message_id, expected_revision, intent, affected_references_json, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, reconciliation.id, reconciliation.conversationId, userMessageId, expectedRevision, intent, JSON.stringify(affectedReferences), now);
  return { id, userMessageId, expectedRevision, intent, affectedReferences: [...affectedReferences] };
}
