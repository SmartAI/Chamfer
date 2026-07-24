import type { DatabaseSync } from "node:sqlite";
import type {
  InspectEvidenceInput,
  InspectionLeaseDto,
  InspectionLeaseEvidenceDto,
  InspectionObservationDto,
  InspectionObservationInput,
} from "@chamfer/shared";
import { AttachmentStorageError, type ImageBlobStore } from "./imageBlobStore";
import { appendEvidenceEvent, projectEvidence } from "./evidenceStore";

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

export function listLegacyInspectionLeases(db: DatabaseSync, conversationId: string, status?: "open" | "closed"): InspectionLeaseDto[] {
  const rows = (status
    ? db.prepare("SELECT * FROM inspection_leases WHERE conversation_id = ? AND status = ? ORDER BY opened_at ASC, rowid ASC").all(conversationId, status)
    : db.prepare("SELECT * FROM inspection_leases WHERE conversation_id = ? ORDER BY opened_at ASC, rowid ASC").all(conversationId)) as unknown as LeaseRow[];
  return rows.map((row) => toDto(db, row));
}

export function listInspectionLeases(db: DatabaseSync, conversationId: string, status?: "open" | "closed"): InspectionLeaseDto[] {
  const leases = projectEvidence(db, conversationId).inspectionLeases;
  return status ? leases.filter((lease) => lease.status === status) : leases;
}

export async function openInspectionLease(
  db: DatabaseSync,
  store: ImageBlobStore,
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
    const existing = projectEvidence(db, conversationId).events.find((event) =>
      event.type === "inspection-lease.opened" && event.data.commandIdempotencyKey === idempotencyKey);
    if (existing && "lease" in existing.data) {
      const exact = existing.data.lease.conversationId === conversationId && existing.data.lease.purpose === purpose &&
        existing.data.lease.evidence.map((item) => item.attachmentId).join("\0") === input.evidenceIds.join("\0");
      if (exact) return existing.data.lease;
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

  const lease: InspectionLeaseDto = {
    id: idempotencyKey ?? crypto.randomUUID(),
    conversationId,
    purpose,
    status: "open",
    openedAt: Date.now(),
    evidence: rows.map((row) => ({ attachmentId: row.id, kind: row.kind, mime: row.mime })),
  };
  appendEvidenceEvent(db, conversationId, {
    id: `${conversationId}:inspection-lease:${lease.id}:opened`,
    type: "inspection-lease.opened",
    data: { lease, ...(idempotencyKey ? { commandIdempotencyKey: idempotencyKey } : {}) },
  });
  return lease;
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
    const existing = projectEvidence(db, conversationId).events.find((event) =>
      event.type === "inspection-lease.closed" && event.data.commandIdempotencyKey === idempotencyKey);
    if (existing && "lease" in existing.data) {
      const observation = existing.data.lease.observation;
      const exact = existing.data.lease.id === leaseId && observation &&
        JSON.stringify(observation.relevantViews) === JSON.stringify(input.relevantViews) &&
        JSON.stringify(observation.facts) === JSON.stringify(input.facts) &&
        JSON.stringify(observation.affectedSpecifications) === JSON.stringify(input.affectedSpecifications) &&
        JSON.stringify(observation.affectedComponents) === JSON.stringify(input.affectedComponents) &&
        (observation.noAffectedEntityReason ?? undefined) === (input.noAffectedEntityReason ?? undefined);
      if (exact) return existing.data.lease;
      throw new InspectionLeaseError("idempotency key conflicts with an existing inspection observation", "conflict");
    }
  }
  const lease = projectEvidence(db, conversationId).inspectionLeases.find((candidate) => candidate.id === leaseId);
  if (!lease) throw new InspectionLeaseError("inspection lease not found", "not-found");
  if (lease.status !== "open") throw new InspectionLeaseError("inspection lease is already closed");
  const now = Date.now();
  const closed: InspectionLeaseDto = {
    ...lease,
    status: "closed",
    closedAt: now,
    observation: {
      id: idempotencyKey ?? crypto.randomUUID(),
      leaseId,
      ...input,
      recordedAt: now,
    },
  };
  appendEvidenceEvent(db, conversationId, {
    id: `${conversationId}:inspection-lease:${closed.id}:closed`,
    type: "inspection-lease.closed",
    data: { lease: closed, ...(idempotencyKey ? { commandIdempotencyKey: idempotencyKey } : {}) },
  });
  return closed;
}
