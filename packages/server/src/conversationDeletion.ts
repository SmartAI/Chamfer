import type { DatabaseSync } from "node:sqlite";
import { AttachmentStore } from "./attachmentStore";
import { conversationExists } from "./conversationStore";

interface BlobCandidate {
  contentHash: string | null;
  blobPath: string | null;
}

export function deleteConversationWithAttachments(
  db: DatabaseSync,
  store: AttachmentStore,
  conversationId: string,
): boolean {
  if (!conversationExists(db, conversationId)) return false;
  const candidates = db.prepare(
    `SELECT DISTINCT content_hash AS contentHash, blob_path AS blobPath
       FROM attachments
      WHERE message_id IN (SELECT id FROM messages WHERE conversation_id = ?)
        AND (content_hash IS NOT NULL OR blob_path IS NOT NULL)`,
  ).all(conversationId) as unknown as BlobCandidate[];
  const attachmentIds = db.prepare(
    "SELECT id FROM attachments WHERE message_id IN (SELECT id FROM messages WHERE conversation_id = ?)",
  ).all(conversationId) as Array<{ id: string }>;

  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM visual_verification_batches WHERE conversation_id = ?").run(conversationId);
    db.prepare("DELETE FROM visual_verifications WHERE conversation_id = ?").run(conversationId);
    db.prepare(`DELETE FROM inspection_observations WHERE lease_id IN
      (SELECT id FROM inspection_leases WHERE conversation_id = ?)` ).run(conversationId);
    db.prepare(`DELETE FROM inspection_lease_evidence WHERE lease_id IN
      (SELECT id FROM inspection_leases WHERE conversation_id = ?)` ).run(conversationId);
    db.prepare("DELETE FROM inspection_leases WHERE conversation_id = ?").run(conversationId);
    db.prepare("DELETE FROM reference_classifications WHERE conversation_id = ?").run(conversationId);
    const hasMigrationDiagnostics = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'image_migration_diagnostics'",
    ).get() !== undefined;
    if (hasMigrationDiagnostics) {
      const deleteDiagnostic = db.prepare("DELETE FROM image_migration_diagnostics WHERE attachment_id = ?");
      for (const attachment of attachmentIds) deleteDiagnostic.run(attachment.id);
    }
    db.prepare(
      "DELETE FROM attachments WHERE message_id IN (SELECT id FROM messages WHERE conversation_id = ?)",
    ).run(conversationId);
    db.prepare("DELETE FROM messages WHERE conversation_id = ?").run(conversationId);
    db.prepare("DELETE FROM artifacts WHERE conversation_id = ?").run(conversationId);
    db.prepare("DELETE FROM conversations WHERE id = ?").run(conversationId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  const referenceCount = db.prepare(
    "SELECT COUNT(*) AS count FROM attachments WHERE content_hash = ? OR blob_path = ?",
  );
  for (const candidate of candidates) {
    const blobPath = candidate.blobPath
      ?? `images/${candidate.contentHash!.slice(0, 2)}/${candidate.contentHash}`;
    const remaining = referenceCount.get(candidate.contentHash, blobPath) as { count: number };
    if (remaining.count !== 0) continue;
    try {
      store.remove(blobPath);
    } catch {
      // Explicit or startup maintenance retries a failed post-commit removal.
    }
  }
  return true;
}
