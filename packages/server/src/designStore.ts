import type { DatabaseSync } from "node:sqlite";
import type {
  CadEnvironment,
  DesignDto,
  DesignRevisionDto,
  Gate,
  Measurements,
  ParamSpec,
  FusionCheckResultDto,
} from "@chamfer/shared";
import { withImmediateTransaction } from "./dbTransaction";
import { ConversationEventStore } from "./conversationEventStore";
import { fusionLedgerActionIdentity } from "./fusion/actionLedger";

interface DesignRow {
  id: string;
  name: string;
  description: string;
  cad_environment: CadEnvironment;
  current_revision: number | null;
  provenance_design_id: string | null;
  provenance_revision: number | null;
  fusion_document_id: string | null;
  fusion_document_name: string | null;
  created_at: number;
  updated_at: number;
  reference_count: number;
}

interface RevisionRow {
  id: string;
  design_id: string;
  revision: number;
  py_source: string | null;
  parameters_json: string;
  gate_json: string;
  measurements_json: string | null;
  source_conversation_id: string | null;
  source_artifact_id: string | null;
  fusion_revision: string | null;
  source_fusion_action_id: string | null;
  provenance_design_id: string | null;
  provenance_revision: number | null;
  created_at: number;
}

const DESIGN_SELECT = `SELECT d.*,
  (SELECT COUNT(*) FROM conversations c WHERE c.design_id = d.id) AS reference_count
  FROM designs d`;

function toDesignDto(row: DesignRow): DesignDto {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    cadEnvironment: row.cad_environment,
    currentRevision: row.current_revision,
    referencedConversationCount: row.reference_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.fusion_document_id && row.fusion_document_name
      ? { fusionDocument: { id: row.fusion_document_id, name: row.fusion_document_name } }
      : {}),
    ...(row.provenance_design_id && row.provenance_revision !== null
      ? { provenance: { designId: row.provenance_design_id, revision: row.provenance_revision } }
      : {}),
  };
}

function parseParameters(value: string): ParamSpec[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed as ParamSpec[] : [];
  } catch {
    return [];
  }
}

function toRevisionDto(row: RevisionRow): DesignRevisionDto {
  return {
    id: row.id,
    designId: row.design_id,
    revision: row.revision,
    pySource: row.py_source,
    parameters: parseParameters(row.parameters_json),
    gate: JSON.parse(row.gate_json) as Gate,
    measurements: row.measurements_json ? JSON.parse(row.measurements_json) as Measurements : null,
    sourceConversationId: row.source_conversation_id,
    sourceArtifactId: row.source_artifact_id,
    ...(row.fusion_revision ? { fusionRevision: row.fusion_revision } : {}),
    ...(row.source_fusion_action_id ? { sourceFusionActionId: row.source_fusion_action_id } : {}),
    ...(row.provenance_design_id && row.provenance_revision !== null
      ? { provenance: { designId: row.provenance_design_id, revision: row.provenance_revision } }
      : {}),
    createdAt: row.created_at,
  };
}

export function createDesign(
  db: DatabaseSync,
  name: string,
  cadEnvironment: CadEnvironment,
  description = "",
): DesignDto {
  const id = crypto.randomUUID();
  const now = Date.now();
  db.prepare(`INSERT INTO designs
    (id, name, description, cad_environment, current_revision, created_at, updated_at)
    VALUES (?, ?, ?, ?, NULL, ?, ?)`)
    .run(id, name, description, cadEnvironment, now, now);
  return getDesign(db, id)!;
}

export function getDesign(db: DatabaseSync, id: string): DesignDto | undefined {
  const row = db.prepare(`${DESIGN_SELECT} WHERE d.id = ?`).get(id) as unknown as DesignRow | undefined;
  return row ? toDesignDto(row) : undefined;
}

export function listDesigns(db: DatabaseSync): DesignDto[] {
  const rows = db.prepare(`${DESIGN_SELECT} ORDER BY d.updated_at DESC, d.rowid DESC`).all() as unknown as DesignRow[];
  return rows.map(toDesignDto);
}

export function updateDesign(
  db: DatabaseSync,
  id: string,
  patch: { name?: string; description?: string },
): DesignDto | undefined {
  const current = getDesign(db, id);
  if (!current) return undefined;
  db.prepare("UPDATE designs SET name = ?, description = ?, updated_at = ? WHERE id = ?")
    .run(patch.name ?? current.name, patch.description ?? current.description, Date.now(), id);
  return getDesign(db, id);
}

export function listDesignRevisions(db: DatabaseSync, designId: string): DesignRevisionDto[] {
  const rows = db.prepare("SELECT * FROM design_revisions WHERE design_id = ? ORDER BY revision")
    .all(designId) as unknown as RevisionRow[];
  return rows.map(toRevisionDto);
}

export function getDesignRevision(
  db: DatabaseSync,
  designId: string,
  revision: number,
): DesignRevisionDto | undefined {
  const row = db.prepare("SELECT * FROM design_revisions WHERE design_id = ? AND revision = ?")
    .get(designId, revision) as unknown as RevisionRow | undefined;
  return row ? toRevisionDto(row) : undefined;
}

export type AppendRevisionResult =
  | { ok: true; revision: DesignRevisionDto }
  | { ok: false; reason: "not-found" | "wrong-design" | "gate-not-passed" };

function copyRevisionGateEvidence(db: DatabaseSync, sourceRevisionId: string, targetRevisionId: string): void {
  db.prepare(`INSERT OR IGNORE INTO design_revision_gate_evidence
      (design_revision_id, source_evidence_id, source_run_id, source_conversation_id,
       source_artifact_id, code_sha256, gate_json, measurements_json, witnessed_at)
    SELECT ?, source_evidence_id, source_run_id, source_conversation_id,
      source_artifact_id, code_sha256, gate_json, measurements_json, witnessed_at
    FROM design_revision_gate_evidence WHERE design_revision_id = ?`)
    .run(targetRevisionId, sourceRevisionId);
}

/** Dimensional pins (the expect-block declaration and its bodies/bbox/volume
 * values, plus frozen `check:*` criteria) restate the dimensions the design
 * had when its plan was accepted - or are absent entirely in user-authored
 * playground code. A user's own parameter edit deliberately changes those
 * dimensions, so the pins it invalidates cannot veto the revision; structural
 * checks (validity, integrity, parameter responsiveness) still can. */
function onlyDimensionalPinsFailed(gate: Gate): boolean {
  const dimensional = new Set(["expect_block", "bodies", "bbox", "volume"]);
  const failed = gate.checks.filter((check) => !check.passed);
  return failed.length > 0 && failed.every(
    (check) => dimensional.has(check.name) || check.name.startsWith("check:"),
  );
}

export function appendArtifactRevision(
  db: DatabaseSync,
  designId: string,
  conversationId: string,
  artifactId: string,
  options?: { userParameterEdit?: boolean },
): AppendRevisionResult {
  const existing = db.prepare("SELECT * FROM design_revisions WHERE source_artifact_id = ?")
    .get(artifactId) as unknown as RevisionRow | undefined;
  if (existing) {
    return existing.design_id === designId
      ? { ok: true, revision: toRevisionDto(existing) }
      : { ok: false, reason: "wrong-design" };
  }
  const source = db.prepare(`SELECT a.*, c.design_id AS design_id
      FROM artifacts a JOIN conversations c ON c.id = a.conversation_id
      WHERE a.id = ? AND a.conversation_id = ?`)
    .get(artifactId, conversationId) as {
      id: string;
      conversation_id: string;
      design_id: string | null;
      py_source: string;
      params_json: string | null;
      gate_json: string | null;
      measurements_json: string | null;
      created_at: number;
    } | undefined;
  if (!source) return { ok: false, reason: "not-found" };
  if (source.design_id !== designId) return { ok: false, reason: "wrong-design" };
  let gate: Gate | undefined;
  try {
    gate = source.gate_json ? JSON.parse(source.gate_json) as Gate : undefined;
  } catch {
    gate = undefined;
  }
  const acceptable = gate?.status === "passed" ||
    (options?.userParameterEdit === true && gate !== undefined && onlyDimensionalPinsFailed(gate));
  if (!acceptable) return { ok: false, reason: "gate-not-passed" };

  return withImmediateTransaction(db, () => {
    const next = db.prepare("SELECT COALESCE(MAX(revision), 0) + 1 AS revision FROM design_revisions WHERE design_id = ?")
      .get(designId) as { revision: number };
    const id = crypto.randomUUID();
    const now = Date.now();
    db.prepare(`INSERT INTO design_revisions
      (id, design_id, revision, py_source, parameters_json, gate_json, measurements_json,
       source_conversation_id, source_artifact_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        id,
        designId,
        next.revision,
        source.py_source,
        source.params_json ?? "[]",
        source.gate_json,
        source.measurements_json,
        conversationId,
        artifactId,
        now,
      );
    db.prepare(`INSERT OR IGNORE INTO design_revision_gate_evidence
        (design_revision_id, source_evidence_id, source_run_id, source_conversation_id,
         source_artifact_id, code_sha256, gate_json, measurements_json, witnessed_at)
      SELECT ?, id, run_id, conversation_id, artifact_id, code_sha256, gate_json, measurements_json, witnessed_at
      FROM cad_gate_evidence WHERE artifact_id = ?`)
      .run(id, artifactId);
    db.prepare("UPDATE designs SET current_revision = ?, updated_at = ? WHERE id = ?")
      .run(next.revision, now, designId);
    return { ok: true, revision: getDesignRevision(db, designId, next.revision)! };
  });
}

export function forkDesign(
  db: DatabaseSync,
  sourceDesignId: string,
  revisionNumber: number,
  name: string,
): DesignDto | undefined {
  const sourceDesign = getDesign(db, sourceDesignId);
  const sourceRevision = getDesignRevision(db, sourceDesignId, revisionNumber);
  if (!sourceDesign || !sourceRevision) return undefined;
  const id = crypto.randomUUID();
  const revisionId = crypto.randomUUID();
  const now = Date.now();
  return withImmediateTransaction(db, () => {
    db.prepare(`INSERT INTO designs
      (id, name, description, cad_environment, current_revision, provenance_design_id,
       provenance_revision, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)`)
      .run(id, name, sourceDesign.description, sourceDesign.cadEnvironment, sourceDesignId, revisionNumber, now, now);
    db.prepare(`INSERT INTO design_revisions
      (id, design_id, revision, py_source, parameters_json, gate_json, measurements_json,
       provenance_design_id, provenance_revision, created_at)
      SELECT ?, ?, 1, py_source, parameters_json, gate_json, measurements_json, ?, ?, ?
      FROM design_revisions WHERE design_id = ? AND revision = ?`)
      .run(revisionId, id, sourceDesignId, revisionNumber, now, sourceDesignId, revisionNumber);
    copyRevisionGateEvidence(db, sourceRevision.id, revisionId);
    return getDesign(db, id)!;
  });
}

export function restoreDesignRevision(
  db: DatabaseSync,
  designId: string,
  revisionNumber: number,
): DesignRevisionDto | undefined {
  const design = getDesign(db, designId);
  const source = getDesignRevision(db, designId, revisionNumber);
  if (!design || design.cadEnvironment !== "build123d" || !source) return undefined;
  return withImmediateTransaction(db, () => {
    const next = db.prepare("SELECT COALESCE(MAX(revision), 0) + 1 AS revision FROM design_revisions WHERE design_id = ?")
      .get(designId) as { revision: number };
    const id = crypto.randomUUID();
    const now = Date.now();
    db.prepare(`INSERT INTO design_revisions
      (id, design_id, revision, py_source, parameters_json, gate_json, measurements_json,
       provenance_design_id, provenance_revision, created_at)
      SELECT ?, ?, ?, py_source, parameters_json, gate_json, measurements_json, ?, ?, ?
      FROM design_revisions WHERE design_id = ? AND revision = ?`)
      .run(id, designId, next.revision, designId, revisionNumber, now, designId, revisionNumber);
    copyRevisionGateEvidence(db, source.id, id);
    db.prepare("UPDATE designs SET current_revision = ?, updated_at = ? WHERE id = ?")
      .run(next.revision, now, designId);
    return getDesignRevision(db, designId, next.revision)!;
  });
}

export function designConversationReferences(
  db: DatabaseSync,
  designId: string,
): Array<{ id: string; title: string }> {
  return db.prepare("SELECT id, title FROM conversations WHERE design_id = ? ORDER BY updated_at DESC")
    .all(designId) as Array<{ id: string; title: string }>;
}

export function deleteDesign(db: DatabaseSync, designId: string): boolean {
  if (!getDesign(db, designId)) return false;
  return withImmediateTransaction(db, () => {
    const references = designConversationReferences(db, designId);
    const events = new ConversationEventStore(db);
    for (const conversation of references) {
      events.append(conversation.id, {
        type: "conversation.design-detached",
        data: { designId },
      });
    }
    db.prepare(`DELETE FROM design_revision_gate_evidence WHERE design_revision_id IN
      (SELECT id FROM design_revisions WHERE design_id = ?)` ).run(designId);
    db.prepare("DELETE FROM design_revisions WHERE design_id = ?").run(designId);
    db.prepare("DELETE FROM designs WHERE id = ?").run(designId);
    return true;
  });
}

export function updateFusionDesignIdentity(
  db: DatabaseSync,
  conversationId: string,
  document: { id: string; name: string },
): void {
  db.prepare(`UPDATE designs SET fusion_document_id = ?, fusion_document_name = ?, name = CASE
      WHEN name = 'Untitled design' THEN ? ELSE name END, updated_at = ?
      WHERE id = (SELECT design_id FROM conversations WHERE id = ?)`)
    .run(document.id, document.name, document.name, Date.now(), conversationId);
}

export function appendFusionDesignRevision(
  db: DatabaseSync,
  designId: string,
  conversationId: string,
  actionId: string,
): DesignRevisionDto | undefined {
  const existing = db.prepare(`SELECT * FROM design_revisions
      WHERE source_conversation_id = ? AND source_fusion_action_id = ?`)
    .get(conversationId, fusionLedgerActionIdentity(actionId)) as unknown as RevisionRow | undefined;
  if (existing) return toRevisionDto(existing);
  const conversation = db.prepare("SELECT design_id AS designId FROM conversations WHERE id = ?")
    .get(conversationId) as { designId: string | null } | undefined;
  const design = getDesign(db, designId);
  if (conversation?.designId !== designId || design?.cadEnvironment !== "fusion") return undefined;
  const completed = db.prepare(`SELECT final_revision AS finalRevision, result_json AS resultJson
      FROM fusion_action_ledger
      WHERE conversation_id = ? AND action_id = ? AND event = 'completed'
      ORDER BY rowid DESC LIMIT 1`)
    .get(conversationId, fusionLedgerActionIdentity(actionId)) as
      { finalRevision: string | null; resultJson: string } | undefined;
  if (!completed?.finalRevision) return undefined;
  const result = JSON.parse(completed.resultJson) as { checks?: FusionCheckResultDto[] };
  const checks = result.checks ?? [];
  const gate: Gate = {
    status: checks.length > 0 && checks.every((check) => check.status === "passed") ? "passed" : "failed",
    checks: checks.map((check) => ({
      name: check.kind,
      passed: check.status === "passed",
      detail: check.detail,
    })),
  };
  if (gate.status !== "passed") return undefined;
  return withImmediateTransaction(db, () => {
    const next = db.prepare("SELECT COALESCE(MAX(revision), 0) + 1 AS revision FROM design_revisions WHERE design_id = ?")
      .get(designId) as { revision: number };
    const id = crypto.randomUUID();
    const now = Date.now();
    db.prepare(`INSERT INTO design_revisions
      (id, design_id, revision, py_source, parameters_json, gate_json, measurements_json,
       source_conversation_id, fusion_revision, source_fusion_action_id, created_at)
      VALUES (?, ?, ?, NULL, '[]', ?, NULL, ?, ?, ?, ?)`)
      .run(
        id,
        designId,
        next.revision,
        JSON.stringify(gate),
        conversationId,
        completed.finalRevision,
        fusionLedgerActionIdentity(actionId),
        now,
      );
    db.prepare("UPDATE designs SET current_revision = ?, updated_at = ? WHERE id = ?")
      .run(next.revision, now, designId);
    return getDesignRevision(db, designId, next.revision);
  });
}
