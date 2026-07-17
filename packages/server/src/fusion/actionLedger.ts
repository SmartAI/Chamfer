import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  FusionActionLedgerEventType, FusionActionLedgerRecordDto, FusionActionRequestDto,
} from "@chamfer/shared";

interface LedgerRow {
  id: string; conversation_id: string; action_id: string; event: FusionActionLedgerEventType; recorded_at: number;
  document_json: string; expected_revision: string; observed_revision: string | null; final_revision: string | null;
  model_json: string; skills_json: string; policy_version: string; intent: string; body_sha256: string;
  affected_references_json: string; expected_effects_json: string; result_json: string; evidence_ids_json: string;
}

const LEDGER_CATEGORICAL_KEYS = new Set(["event", "kind", "reason", "requiredViews", "state", "status", "strategy"]);

function privateLedgerString(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function privateLedgerValue(value: unknown, key?: string): unknown {
  if (typeof value === "string") return LEDGER_CATEGORICAL_KEYS.has(key ?? "") ? value : privateLedgerString(value);
  if (Array.isArray(value)) return value.map((item) => privateLedgerValue(item, key));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([childKey, child]) =>
    [childKey, privateLedgerValue(child, childKey)]));
}

export function fusionLedgerActionIdentity(actionId: string): string {
  return privateLedgerString(actionId);
}

function parse(row: LedgerRow): FusionActionLedgerRecordDto {
  return {
    id: row.id, conversationId: row.conversation_id, actionId: row.action_id, event: row.event,
    recordedAt: row.recorded_at, document: JSON.parse(row.document_json), expectedRevision: row.expected_revision,
    ...(row.observed_revision ? { observedRevision: row.observed_revision } : {}),
    ...(row.final_revision ? { finalRevision: row.final_revision } : {}),
    model: JSON.parse(row.model_json), skills: JSON.parse(row.skills_json), policyVersion: row.policy_version,
    intent: row.intent, bodySha256: row.body_sha256, affectedReferences: JSON.parse(row.affected_references_json),
    expectedEffects: JSON.parse(row.expected_effects_json), result: JSON.parse(row.result_json),
    evidenceIds: JSON.parse(row.evidence_ids_json),
  };
}

export function appendFusionActionLedger(
  db: DatabaseSync,
  conversationId: string,
  request: FusionActionRequestDto,
  policyVersion: string,
  event: FusionActionLedgerEventType,
  details: { observedRevision?: string; finalRevision?: string; result?: Record<string, unknown>; evidenceIds?: string[] } = {},
  now = Date.now(),
): FusionActionLedgerRecordDto {
  const id = randomUUID();
  const privateDocument = {
    id: privateLedgerString(request.document.id),
    name: "[bound Fusion document]",
    ...(request.document.dataFileId ? { dataFileId: privateLedgerString(request.document.dataFileId) } : {}),
  };
  db.prepare(`INSERT INTO fusion_action_ledger
    (id, conversation_id, action_id, event, recorded_at, document_json, expected_revision, observed_revision,
     final_revision, model_json, skills_json, policy_version, intent, body_sha256, affected_references_json,
     expected_effects_json, result_json, evidence_ids_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, conversationId, fusionLedgerActionIdentity(request.actionId), event, now, JSON.stringify(privateDocument),
      privateLedgerString(request.expectedRevision), details.observedRevision ?? null, details.finalRevision ?? null,
      JSON.stringify(privateLedgerValue(request.model)), JSON.stringify(privateLedgerValue(request.skills)),
      policyVersion, privateLedgerString(request.intent), createHash("sha256").update(request.body).digest("hex"),
      JSON.stringify(privateLedgerValue(request.affectedReferences)), JSON.stringify(privateLedgerValue(request.expectedEffects ?? [])),
      JSON.stringify(privateLedgerValue(details.result ?? {})),
      JSON.stringify((details.evidenceIds ?? [request.expectedEvidenceId]).map(privateLedgerString)));
  return parse(db.prepare("SELECT * FROM fusion_action_ledger WHERE id = ?").get(id) as unknown as LedgerRow);
}

export function listFusionActionLedger(db: DatabaseSync, conversationId: string): FusionActionLedgerRecordDto[] {
  return (db.prepare("SELECT * FROM fusion_action_ledger WHERE conversation_id = ? ORDER BY recorded_at, rowid")
    .all(conversationId) as unknown as LedgerRow[]).map(parse);
}

/** Stores the minimum unredacted local state needed to reconcile the live
 * document. This table is never exposed through the action-history API or sent
 * to a model provider; the public audit projection remains hashed. */
export function recordFusionActionOperationalContext(
  db: DatabaseSync,
  conversationId: string,
  request: Pick<FusionActionRequestDto, "actionId" | "affectedReferences" | "expectedEffects">,
  now = Date.now(),
): void {
  db.prepare(`INSERT OR IGNORE INTO fusion_action_operational_context
    (action_id, conversation_id, affected_references_json, expected_effects_json, recorded_at)
    VALUES (?, ?, ?, ?, ?)`).run(fusionLedgerActionIdentity(request.actionId), conversationId,
      JSON.stringify(request.affectedReferences), JSON.stringify(request.expectedEffects ?? []), now);
}

export function latestCompletedFusionOperationalContext(
  db: DatabaseSync,
  conversationId: string,
): Pick<FusionActionRequestDto, "affectedReferences" | "expectedEffects"> | undefined {
  const completed = listFusionActionLedger(db, conversationId)
    .filter((record) => record.event === "completed" && record.result.status === "completed").at(-1);
  if (!completed) return undefined;
  const row = db.prepare(`SELECT affected_references_json, expected_effects_json
    FROM fusion_action_operational_context WHERE action_id = ? AND conversation_id = ?`)
    .get(completed.actionId, conversationId) as { affected_references_json: string; expected_effects_json: string } | undefined;
  return row ? {
    affectedReferences: JSON.parse(row.affected_references_json),
    expectedEffects: JSON.parse(row.expected_effects_json),
  } : undefined;
}
