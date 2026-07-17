import type { DatabaseSync } from "node:sqlite";
import type {
  FusionDocumentBindingDto,
  FusionDocumentIdentityDto,
  FusionOwnershipRole,
} from "@chamfer/shared";

interface BindingRow {
  conversation_id: string;
  endpoint: string;
  document_id: string;
  document_name: string;
  data_file_id: string | null;
  data_file_version_id: string | null;
  data_file_version_number: number | null;
  role: FusionOwnershipRole;
  resumable: number;
  bound_at: number;
  updated_at: number;
}

function toDto(row: BindingRow): FusionDocumentBindingDto {
  return {
    conversationId: row.conversation_id,
    endpoint: row.endpoint,
    document: {
      id: row.document_id,
      name: row.document_name,
      ...(row.data_file_id ? { dataFileId: row.data_file_id } : {}),
      ...(row.data_file_version_id ? { versionId: row.data_file_version_id } : {}),
      ...(row.data_file_version_number !== null ? { versionNumber: row.data_file_version_number } : {}),
    },
    identityKind: row.data_file_id ? "durable" : "provisional",
    role: row.role,
    resumable: row.resumable === 1,
    boundAt: row.bound_at,
    updatedAt: row.updated_at,
  };
}

export function getFusionBinding(db: DatabaseSync, conversationId: string): FusionDocumentBindingDto | undefined {
  const row = db.prepare("SELECT * FROM fusion_document_bindings WHERE conversation_id = ?")
    .get(conversationId) as unknown as BindingRow | undefined;
  return row ? toDto(row) : undefined;
}

export function getManagedFusionBinding(db: DatabaseSync, endpoint: string): FusionDocumentBindingDto | undefined {
  // Only a RESUMABLE binding manages the endpoint. A non-resumable row (its
  // provisional document was confirmed closed, or it was otherwise released)
  // must not keep managing the endpoint: fusionDocumentMatches() returns false
  // for it, so if it were still "managed" it would 409 every fresh conversation
  // in bind()/transfer() with no in-product escape - the stale-binding deadlock.
  const row = db.prepare(
    "SELECT * FROM fusion_document_bindings WHERE endpoint = ? AND resumable = 1 ORDER BY role = 'owner' DESC, bound_at ASC LIMIT 1",
  ).get(endpoint) as unknown as BindingRow | undefined;
  return row ? toDto(row) : undefined;
}

/** Remove dead (non-resumable) bindings for an endpoint. A non-resumable binding
 * means its provisional document was confirmed closed or otherwise released, so it
 * no longer manages the endpoint. getManagedFusionBinding already ignores such rows,
 * but the partial unique index on (endpoint) WHERE role='owner' still reserves the
 * owner slot, so a fresh owner INSERT would collide; clearing the dead row first
 * frees the slot. Returns the number of rows released. */
export function releaseDeadFusionBindings(db: DatabaseSync, endpoint: string): number {
  return Number(db.prepare("DELETE FROM fusion_document_bindings WHERE endpoint = ? AND resumable = 0").run(endpoint).changes);
}

export function fusionDocumentMatches(
  binding: FusionDocumentBindingDto,
  endpoint: string,
  document: FusionDocumentIdentityDto | undefined,
): boolean {
  if (binding.endpoint !== endpoint || !document || !binding.resumable) return false;
  return binding.document.dataFileId
    ? document.dataFileId === binding.document.dataFileId
    : document.id === binding.document.id;
}

export function insertFusionBinding(
  db: DatabaseSync,
  conversationId: string,
  endpoint: string,
  document: FusionDocumentIdentityDto,
  role: FusionOwnershipRole,
  now = Date.now(),
): FusionDocumentBindingDto {
  db.prepare(`
    INSERT INTO fusion_document_bindings
      (conversation_id, endpoint, document_id, document_name, data_file_id, data_file_version_id,
       data_file_version_number, role, resumable, bound_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).run(conversationId, endpoint, document.id, document.name, document.dataFileId ?? null,
    document.versionId ?? null, document.versionNumber ?? null, role, now, now);
  return getFusionBinding(db, conversationId)!;
}

/** Refresh display identity and promote creation identity after Save. Promotion is only
 * valid while the exact provisionally bound document remains active. */
export function refreshFusionBinding(
  db: DatabaseSync,
  binding: FusionDocumentBindingDto,
  document: FusionDocumentIdentityDto | undefined,
  provisionalDocumentOpen?: boolean,
  now = Date.now(),
): FusionDocumentBindingDto {
  if (!binding.resumable) return binding;
  if (!fusionDocumentMatches(binding, binding.endpoint, document)) {
    // A different active tab alone does not prove closure. The trusted open-
    // document inspection must confirm loss before the creation identity expires.
    if (binding.identityKind === "provisional" && (!document || provisionalDocumentOpen === false)) {
      db.prepare("UPDATE fusion_document_bindings SET resumable = 0, updated_at = ? WHERE conversation_id = ?")
        .run(now, binding.conversationId);
      return getFusionBinding(db, binding.conversationId)!;
    }
    return binding;
  }
  db.prepare(`
    UPDATE fusion_document_bindings
    SET document_id = ?, document_name = ?, data_file_id = COALESCE(data_file_id, ?),
        data_file_version_id = COALESCE(?, data_file_version_id),
        data_file_version_number = COALESCE(?, data_file_version_number), updated_at = ?
    WHERE conversation_id = ?
  `).run(document!.id, document!.name, document!.dataFileId ?? null,
    document!.versionId ?? null, document!.versionNumber ?? null, now, binding.conversationId);
  return getFusionBinding(db, binding.conversationId)!;
}

/** Demote the endpoint's current owner to historical read-only so a new owner
 * can bind the NOW-ACTIVE document. The demoted conversation keeps its binding
 * (and its ledgers) as read-only history; it can regain mutation authority only
 * through an explicit ownership transfer. */
export function demoteFusionOwner(db: DatabaseSync, endpoint: string, now = Date.now()): void {
  db.prepare("UPDATE fusion_document_bindings SET role = 'read-only', updated_at = ? WHERE endpoint = ? AND role = 'owner'")
    .run(now, endpoint);
}

export function transferFusionOwnership(
  db: DatabaseSync,
  endpoint: string,
  receiverConversationId: string,
  now = Date.now(),
): FusionDocumentBindingDto {
  db.prepare("UPDATE fusion_document_bindings SET role = 'read-only', updated_at = ? WHERE endpoint = ? AND role = 'owner'")
    .run(now, endpoint);
  db.prepare("UPDATE fusion_document_bindings SET role = 'owner', updated_at = ? WHERE conversation_id = ?")
    .run(now, receiverConversationId);
  return getFusionBinding(db, receiverConversationId)!;
}
