import type { DatabaseSync } from "node:sqlite";
import type {
  ClassifyReferenceInput,
  ReferenceClassificationDto,
  ReferenceClassificationStatus,
  ReferenceRecordDto,
  ReferenceRelationship,
} from "@chamfer/shared";
import type { ImageBlobStore } from "./imageBlobStore";
import { getAttachment } from "./conversationStore";
import { listSourceSpecifications } from "./sourceSpecifications";
import { appendEvidenceEvent, projectEvidence } from "./evidenceStore";

interface ReferenceRow {
  reference_id: string;
  conversation_id: string;
  classification_id: string | null;
  status: string | null;
  purpose: string | null;
  relationships_json: string | null;
  rationale: string | null;
  specification_links_json: string | null;
  specification_ids_json: string | null;
  legacy_specification_links_json: string | null;
  no_specification_reason: string | null;
  actor: string | null;
  created_at: number | null;
}

export class ReferenceClassificationError extends Error {
  constructor(message: string, readonly code: "invalid" | "conflict" = "invalid") { super(message); }
}

const STATUSES = new Set<ReferenceClassificationStatus>(["active", "complementary", "superseded"]);
const RELATIONSHIP_TYPES = new Set(["complements", "superseded-by"]);

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function parseJsonArray<T>(json: string | null): T[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

function toClassification(row: ReferenceRow): ReferenceClassificationDto | undefined {
  if (!row.classification_id || !row.status || !row.purpose || !row.rationale || !row.actor || row.created_at === null) {
    return undefined;
  }
  const specificationIds = parseJsonArray<string>(row.specification_ids_json ?? row.specification_links_json);
  const legacySpecificationLinks = parseJsonArray<string>(row.legacy_specification_links_json);
  return {
    id: row.classification_id,
    conversationId: row.conversation_id,
    referenceId: row.reference_id,
    status: row.status as ReferenceClassificationStatus,
    purpose: row.purpose,
    relationships: parseJsonArray<ReferenceRelationship>(row.relationships_json),
    rationale: row.rationale,
    specificationIds,
    specificationLinks: specificationIds,
    ...(legacySpecificationLinks.length > 0 ? { legacySpecificationLinks } : {}),
    ...(row.no_specification_reason ? { noSpecificationReason: row.no_specification_reason } : {}),
    actor: row.actor as "agent",
    timestamp: row.created_at,
  };
}

function historyFor(db: DatabaseSync, conversationId: string, referenceId: string): ReferenceClassificationDto[] {
  const rows = db.prepare(`
    SELECT reference_id, conversation_id, id AS classification_id, status, purpose,
      relationships_json, rationale, specification_links_json, specification_ids_json,
      legacy_specification_links_json, no_specification_reason,
      actor, created_at
    FROM reference_classifications
    WHERE conversation_id = ? AND reference_id = ?
    ORDER BY created_at ASC, rowid ASC
  `).all(conversationId, referenceId) as unknown as ReferenceRow[];
  return rows.flatMap((row) => {
    const classification = toClassification(row);
    return classification ? [classification] : [];
  });
}

export function listLegacyReferenceRecords(db: DatabaseSync, conversationId: string): ReferenceRecordDto[] {
  const rows = db.prepare(`
    SELECT a.id AS reference_id, m.conversation_id,
      rc.id AS classification_id, rc.status, rc.purpose, rc.relationships_json,
      rc.rationale, rc.specification_links_json, rc.specification_ids_json,
      rc.legacy_specification_links_json, rc.no_specification_reason,
      rc.actor, rc.created_at
    FROM attachments a
    JOIN messages m ON m.id = a.message_id
    LEFT JOIN reference_classifications rc ON rc.rowid = (
      SELECT current.rowid FROM reference_classifications current
      WHERE current.conversation_id = m.conversation_id AND current.reference_id = a.id
      ORDER BY current.created_at DESC, current.rowid DESC LIMIT 1
    )
    WHERE m.conversation_id = ? AND a.kind = 'user-image'
    ORDER BY m.seq ASC, a.display_order ASC, a.rowid ASC
  `).all(conversationId) as unknown as ReferenceRow[];
  return rows.map((row) => {
    const current = toClassification(row);
    return {
      referenceId: row.reference_id,
      conversationId: row.conversation_id,
      attachmentAvailable: true,
      status: current?.status ?? "unclassified",
      purpose: current?.purpose,
      relationships: current?.relationships ?? [],
      rationale: current?.rationale,
      specificationIds: current?.specificationIds ?? [],
      specificationLinks: current?.specificationLinks ?? [],
      legacySpecificationLinks: current?.legacySpecificationLinks,
      noSpecificationReason: current?.noSpecificationReason,
      actor: current?.actor,
      timestamp: current?.timestamp,
      history: historyFor(db, conversationId, row.reference_id),
    };
  });
}

export function listReferenceRecords(db: DatabaseSync, conversationId: string): ReferenceRecordDto[] {
  const projected = new Map(projectEvidence(db, conversationId).referenceRecords
    .map((record) => [record.referenceId, record]));
  const references = db.prepare(`SELECT a.id AS referenceId
    FROM attachments a JOIN messages m ON m.id = a.message_id
    WHERE m.conversation_id = ? AND a.kind = 'user-image'
    ORDER BY m.seq ASC, a.display_order ASC, a.rowid ASC`)
    .all(conversationId) as Array<{ referenceId: string }>;
  return references.map(({ referenceId }) => projected.get(referenceId) ?? {
    referenceId,
    conversationId,
    attachmentAvailable: true,
    status: "unclassified",
    relationships: [],
    specificationIds: [],
    specificationLinks: [],
    history: [],
  });
}

export async function listReferenceRecordsWithAvailability(
  db: DatabaseSync,
  store: ImageBlobStore,
  conversationId: string,
): Promise<ReferenceRecordDto[]> {
  return Promise.all(listReferenceRecords(db, conversationId).map(async (record) => {
    const attachment = getAttachment(db, record.referenceId);
    if (!attachment) return { ...record, attachmentAvailable: false };
    if (attachment.storage === "legacy") {
      return { ...record, attachmentAvailable: attachment.data.byteLength > 0 };
    }
    try {
      await store.read(attachment);
      return { ...record, attachmentAvailable: true };
    } catch {
      return { ...record, attachmentAvailable: false };
    }
  }));
}

function validateInput(input: ClassifyReferenceInput): void {
  if (!input || typeof input !== "object") {
    throw new ReferenceClassificationError("reference classification is required");
  }
  if (!STATUSES.has(input.status)) throw new ReferenceClassificationError("invalid reference status");
  if (!nonEmpty(input.purpose)) throw new ReferenceClassificationError("purpose is required");
  if (!nonEmpty(input.rationale)) throw new ReferenceClassificationError("rationale is required");
  if (!Array.isArray(input.relationships)) throw new ReferenceClassificationError("relationships must be an array");
  if (input.relationships.some((relationship) =>
    typeof relationship !== "object" || relationship === null ||
    !RELATIONSHIP_TYPES.has(relationship.type) || !nonEmpty(relationship.referenceId))) {
    throw new ReferenceClassificationError("invalid reference relationship");
  }
  if (input.specificationIds !== undefined && input.specificationLinks !== undefined) {
    throw new ReferenceClassificationError("provide specificationIds, not both specificationIds and legacy specificationLinks");
  }
  const provided = input.specificationIds ?? input.specificationLinks;
  if (!Array.isArray(provided)) {
    throw new ReferenceClassificationError("specificationIds must be an array");
  }
  if (provided.some((id) => !nonEmpty(id))) {
    throw new ReferenceClassificationError("specificationIds must contain non-empty identities");
  }
  const links = provided.filter(nonEmpty);
  if (new Set(links.map((link) => link.trim())).size !== links.length) {
    throw new ReferenceClassificationError("specificationIds must be unique");
  }
  const reason = input.noSpecificationReason?.trim();
  if ((links.length === 0) === !reason) {
    throw new ReferenceClassificationError("provide specificationIds or noSpecificationReason, but not both");
  }
  const supersededBy = input.relationships.filter((relationship) => relationship.type === "superseded-by");
  if (input.status === "superseded" && supersededBy.length === 0) {
    throw new ReferenceClassificationError("superseded references require a superseded-by relationship");
  }
  if (input.status !== "superseded" && supersededBy.length > 0) {
    throw new ReferenceClassificationError("only superseded references may use superseded-by relationships");
  }
}

/** Links prefixed `plan.spec_sheet.` name rows of the accepted design plan's
 * spec sheet rather than durable source specifications. Fusion image flows use
 * them (the Fusion environment records requirements in the plan spec sheet and
 * exposes no source-specification tool), and the plan validator - not this
 * store - owns spec-sheet row identity. */
const PLAN_SPEC_SHEET_LINK_PREFIX = "plan.spec_sheet.";

function assertSpecificationOwnership(
  db: DatabaseSync,
  conversationId: string,
  linkedIds: readonly string[],
): void {
  const specificationIds = linkedIds.filter((id) => !id.startsWith(PLAN_SPEC_SHEET_LINK_PREFIX));
  const specifications = new Map(listSourceSpecifications(db, conversationId)
    .map((specification) => [specification.id, specification]));
  for (const specificationId of specificationIds) {
    const specification = specifications.get(specificationId);
    if (!specification) {
      throw new ReferenceClassificationError(`specification ${specificationId} does not exist`);
    }
    if (specification.status !== "active") {
      throw new ReferenceClassificationError(`specification ${specificationId} is superseded`);
    }
  }
}

function assertOwnership(db: DatabaseSync, conversationId: string, referenceId: string): void {
  const row = db.prepare(`
    SELECT m.conversation_id, a.kind FROM attachments a
    JOIN messages m ON m.id = a.message_id WHERE a.id = ?
  `).get(referenceId) as { conversation_id: string; kind: string } | undefined;
  if (!row || row.kind !== "user-image" || row.conversation_id !== conversationId) {
    throw new ReferenceClassificationError(`reference ${referenceId} does not belong to this conversation`);
  }
}

function assertNoSupersessionCycle(
  records: ReferenceRecordDto[],
  input: ClassifyReferenceInput,
): void {
  const edges = new Map<string, string[]>();
  for (const record of records) {
    if (record.referenceId === input.referenceId) continue;
    edges.set(record.referenceId, record.relationships
      .filter((relationship) => relationship.type === "superseded-by")
      .map((relationship) => relationship.referenceId));
  }
  edges.set(input.referenceId, input.relationships
    .filter((relationship) => relationship.type === "superseded-by")
    .map((relationship) => relationship.referenceId));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    if ((edges.get(id) ?? []).some(visit)) return true;
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  if ([...edges.keys()].some(visit)) throw new ReferenceClassificationError("supersession cycle rejected");
}

export function classifyReference(
  db: DatabaseSync,
  conversationId: string,
  input: ClassifyReferenceInput,
  idempotencyKey?: string,
): ReferenceClassificationDto {
  validateInput(input);
  const submittedIds = input.specificationIds ?? input.specificationLinks ?? [];
  const specificationIds = submittedIds.map((link) => link.trim()).filter(nonEmpty);
  const legacySpecificationLinks = input.specificationIds === undefined && input.specificationLinks !== undefined
    ? specificationIds
    : undefined;
  const normalized = {
    ...input,
    purpose: input.purpose.trim(),
    rationale: input.rationale.trim(),
    specificationIds,
    specificationLinks: specificationIds,
    ...(legacySpecificationLinks ? { legacySpecificationLinks } : {}),
    ...(input.noSpecificationReason ? { noSpecificationReason: input.noSpecificationReason.trim() } : {}),
  };
  if (idempotencyKey) {
    const existing = projectEvidence(db, conversationId).referenceRecords
      .flatMap((record) => record.history)
      .find((classification) => classification.id === idempotencyKey);
    if (existing) {
      const exact = existing.conversationId === conversationId && existing.referenceId === normalized.referenceId &&
        existing.status === normalized.status && existing.purpose === normalized.purpose &&
        JSON.stringify(existing.relationships) === JSON.stringify(normalized.relationships) &&
        existing.rationale === normalized.rationale &&
        JSON.stringify(existing.specificationIds) === JSON.stringify(normalized.specificationIds) &&
        JSON.stringify(existing.legacySpecificationLinks) === JSON.stringify(normalized.legacySpecificationLinks) &&
        (existing.noSpecificationReason ?? undefined) === (normalized.noSpecificationReason ?? undefined);
      if (exact) return existing;
      throw new ReferenceClassificationError("idempotency key conflicts with an existing classification", "conflict");
    }
  }
  assertOwnership(db, conversationId, input.referenceId);
  assertSpecificationOwnership(db, conversationId, specificationIds);
  for (const relationship of input.relationships) {
    if (relationship.referenceId === input.referenceId) {
      throw new ReferenceClassificationError("a reference cannot relate to itself");
    }
    assertOwnership(db, conversationId, relationship.referenceId);
  }
  assertNoSupersessionCycle(projectEvidence(db, conversationId).referenceRecords, input);
  const classification: ReferenceClassificationDto = {
    ...normalized,
    id: idempotencyKey ?? crypto.randomUUID(),
    conversationId,
    actor: "agent",
    timestamp: Date.now(),
  };
  appendEvidenceEvent(db, conversationId, {
    id: `${conversationId}:reference-classification:${classification.id}`,
    type: "reference.classified",
    data: { classification, attachmentAvailable: true },
  });
  return classification;
}
