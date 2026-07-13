import type { DatabaseSync } from "node:sqlite";
import type {
  InspectEvidenceInput,
  InspectionLeaseDto,
  InspectionLeaseEvidenceDto,
  InspectionObservationDto,
  InspectionObservationInput,
} from "@chamfer/shared";
import { AttachmentStorageError, type AttachmentStore } from "./attachmentStore";

interface EvidenceRow {
  id: string;
  conversation_id: string;
  kind: InspectionLeaseEvidenceDto["kind"];
  mime: string;
  content_hash: string | null;
  byte_size: number | null;
  blob_path: string | null;
}

interface LeaseRow {
  id: string;
  conversation_id: string;
  purpose: string;
  status: "open" | "closed";
  opened_at: number;
  closed_at: number | null;
}

interface ObservationRow {
  id: string;
  lease_id: string;
  relevant_views_json: string;
  facts_json: string;
  affected_specifications_json: string;
  affected_components_json: string;
  no_affected_entity_reason: string | null;
  recorded_at: number;
}

export class InspectionLeaseError extends Error {
  constructor(message: string, readonly code: "invalid" | "missing" | "corrupt" | "not-found" | "conflict" = "invalid") {
    super(message);
  }
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function evidenceRow(db: DatabaseSync, id: string): EvidenceRow | undefined {
  return db.prepare(`
    SELECT a.id, m.conversation_id, a.kind, a.mime, a.content_hash, a.byte_size, a.blob_path
    FROM attachments a JOIN messages m ON m.id = a.message_id WHERE a.id = ?
  `).get(id) as unknown as EvidenceRow | undefined;
}

function evidenceFor(db: DatabaseSync, leaseId: string): InspectionLeaseEvidenceDto[] {
  return db.prepare(`
    SELECT a.id AS attachmentId, a.kind, a.mime
    FROM inspection_lease_evidence selected
    JOIN attachments a ON a.id = selected.attachment_id
    WHERE selected.lease_id = ? ORDER BY selected.display_order ASC
  `).all(leaseId) as unknown as InspectionLeaseEvidenceDto[];
}

function observationFor(db: DatabaseSync, leaseId: string): InspectionObservationDto | undefined {
  const row = db.prepare("SELECT * FROM inspection_observations WHERE lease_id = ?").get(leaseId) as unknown as ObservationRow | undefined;
  if (!row) return undefined;
  return {
    id: row.id,
    leaseId: row.lease_id,
    relevantViews: JSON.parse(row.relevant_views_json) as string[],
    facts: JSON.parse(row.facts_json) as string[],
    affectedSpecifications: JSON.parse(row.affected_specifications_json) as string[],
    affectedComponents: JSON.parse(row.affected_components_json) as string[],
    ...(row.no_affected_entity_reason ? { noAffectedEntityReason: row.no_affected_entity_reason } : {}),
    recordedAt: row.recorded_at,
  };
}

function toDto(db: DatabaseSync, row: LeaseRow): InspectionLeaseDto {
  const observation = observationFor(db, row.id);
  return {
    id: row.id,
    conversationId: row.conversation_id,
    purpose: row.purpose,
    status: row.status,
    evidence: evidenceFor(db, row.id),
    openedAt: row.opened_at,
    ...(row.closed_at === null ? {} : { closedAt: row.closed_at }),
    ...(observation ? { observation } : {}),
  };
}

export function listInspectionLeases(db: DatabaseSync, conversationId: string, status?: "open" | "closed"): InspectionLeaseDto[] {
  const rows = (status
    ? db.prepare("SELECT * FROM inspection_leases WHERE conversation_id = ? AND status = ? ORDER BY opened_at ASC, rowid ASC").all(conversationId, status)
    : db.prepare("SELECT * FROM inspection_leases WHERE conversation_id = ? ORDER BY opened_at ASC, rowid ASC").all(conversationId)) as unknown as LeaseRow[];
  return rows.map((row) => toDto(db, row));
}

export async function openInspectionLease(
  db: DatabaseSync,
  store: AttachmentStore,
  conversationId: string,
  input: InspectEvidenceInput,
  idempotencyKey?: string,
): Promise<InspectionLeaseDto> {
  if (!nonEmpty(input.purpose)) throw new InspectionLeaseError("purpose is required");
  if (!Array.isArray(input.evidenceIds) || input.evidenceIds.length === 0) {
    throw new InspectionLeaseError("at least one evidence ID is required");
  }
  if (new Set(input.evidenceIds).size !== input.evidenceIds.length || input.evidenceIds.some((id) => !nonEmpty(id))) {
    throw new InspectionLeaseError("evidence IDs must be unique non-empty strings");
  }
  const purpose = input.purpose.trim();
  if (idempotencyKey) {
    const existing = db.prepare("SELECT * FROM inspection_leases WHERE id = ?").get(idempotencyKey) as unknown as LeaseRow | undefined;
    if (existing) {
      const exact = existing.conversation_id === conversationId && existing.purpose === purpose &&
        evidenceFor(db, existing.id).map((item) => item.attachmentId).join("\0") === input.evidenceIds.join("\0");
      if (exact) return toDto(db, existing);
      throw new InspectionLeaseError("idempotency key conflicts with an existing inspection lease", "conflict");
    }
  }

  const rows: EvidenceRow[] = [];
  for (const id of input.evidenceIds) {
    const row = evidenceRow(db, id);
    if (!row || row.conversation_id !== conversationId || (row.kind !== "user-image" && row.kind !== "view-sheet")) {
      throw new InspectionLeaseError(`evidence ${id} does not belong to this conversation`);
    }
    if (!row.content_hash || row.byte_size === null || !row.blob_path) {
      throw new InspectionLeaseError(`evidence ${id} is missing`, "missing");
    }
    try {
      await store.read({
        mime: row.mime,
        contentHash: row.content_hash,
        byteSize: row.byte_size,
        blobPath: row.blob_path,
      });
    } catch (error) {
      if (!(error instanceof AttachmentStorageError)) throw error;
      const state = error.code === "missing" ? "missing" : "corrupt";
      throw new InspectionLeaseError(`evidence ${id} is ${state}`, state);
    }
    rows.push(row);
  }

  const lease: LeaseRow = {
    id: idempotencyKey ?? crypto.randomUUID(),
    conversation_id: conversationId,
    purpose,
    status: "open",
    opened_at: Date.now(),
    closed_at: null,
  };
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("INSERT INTO inspection_leases (id, conversation_id, purpose, status, opened_at) VALUES (?, ?, ?, 'open', ?)")
      .run(lease.id, conversationId, lease.purpose, lease.opened_at);
    const insert = db.prepare("INSERT INTO inspection_lease_evidence (lease_id, attachment_id, display_order) VALUES (?, ?, ?)");
    rows.forEach((row, index) => insert.run(lease.id, row.id, index));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return toDto(db, lease);
}

function validateObservation(input: InspectionObservationInput): InspectionObservationInput {
  if (!Array.isArray(input.relevantViews) || input.relevantViews.length === 0 || !input.relevantViews.every(nonEmpty)) {
    throw new InspectionLeaseError("at least one relevant view is required");
  }
  if (!Array.isArray(input.facts) || input.facts.length === 0 || !input.facts.every(nonEmpty)) {
    throw new InspectionLeaseError("at least one inspection fact is required");
  }
  if (!Array.isArray(input.affectedSpecifications) || !input.affectedSpecifications.every(nonEmpty) ||
      !Array.isArray(input.affectedComponents) || !input.affectedComponents.every(nonEmpty)) {
    throw new InspectionLeaseError("affected specifications and components must be arrays of non-empty strings");
  }
  const hasAffectedEntity = input.affectedSpecifications.length > 0 || input.affectedComponents.length > 0;
  const reason = input.noAffectedEntityReason?.trim();
  if (hasAffectedEntity === Boolean(reason)) {
    throw new InspectionLeaseError("provide affected specifications or components, or noAffectedEntityReason");
  }
  return {
    relevantViews: input.relevantViews.map((value) => value.trim()),
    facts: input.facts.map((value) => value.trim()),
    affectedSpecifications: input.affectedSpecifications.map((value) => value.trim()),
    affectedComponents: input.affectedComponents.map((value) => value.trim()),
    ...(reason ? { noAffectedEntityReason: reason } : {}),
  };
}

export function recordInspectionObservation(
  db: DatabaseSync,
  conversationId: string,
  leaseId: string,
  raw: InspectionObservationInput,
  idempotencyKey?: string,
): InspectionLeaseDto {
  const input = validateObservation(raw);
  if (idempotencyKey) {
    const existing = db.prepare("SELECT * FROM inspection_observations WHERE id = ?").get(idempotencyKey) as unknown as ObservationRow | undefined;
    if (existing) {
      const exact = existing.lease_id === leaseId &&
        existing.relevant_views_json === JSON.stringify(input.relevantViews) &&
        existing.facts_json === JSON.stringify(input.facts) &&
        existing.affected_specifications_json === JSON.stringify(input.affectedSpecifications) &&
        existing.affected_components_json === JSON.stringify(input.affectedComponents) &&
        (existing.no_affected_entity_reason ?? undefined) === (input.noAffectedEntityReason ?? undefined);
      const lease = db.prepare("SELECT * FROM inspection_leases WHERE id = ? AND conversation_id = ?")
        .get(leaseId, conversationId) as unknown as LeaseRow | undefined;
      if (exact && lease) return toDto(db, lease);
      throw new InspectionLeaseError("idempotency key conflicts with an existing inspection observation", "conflict");
    }
  }
  const lease = db.prepare("SELECT * FROM inspection_leases WHERE id = ? AND conversation_id = ?").get(leaseId, conversationId) as unknown as LeaseRow | undefined;
  if (!lease) throw new InspectionLeaseError("inspection lease not found", "not-found");
  if (lease.status !== "open") throw new InspectionLeaseError("inspection lease is already closed");
  const now = Date.now();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`INSERT INTO inspection_observations
      (id, lease_id, relevant_views_json, facts_json, affected_specifications_json,
       affected_components_json, no_affected_entity_reason, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(idempotencyKey ?? crypto.randomUUID(), leaseId, JSON.stringify(input.relevantViews), JSON.stringify(input.facts),
        JSON.stringify(input.affectedSpecifications), JSON.stringify(input.affectedComponents),
        input.noAffectedEntityReason ?? null, now);
    db.prepare("UPDATE inspection_leases SET status = 'closed', closed_at = ? WHERE id = ? AND status = 'open'").run(now, leaseId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return toDto(db, { ...lease, status: "closed", closed_at: now });
}
