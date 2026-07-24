import type { DatabaseSync } from "node:sqlite";
import type { ImageBlobStore } from "./imageBlobStore";
import { conversationExists } from "./conversationStore";
import { releaseFusionRecoveriesOwnedByConversation } from "./fusion/recoveryStore";
import { invalidateConversationProjection } from "./conversationEventStore";
import { invalidateEvidenceProjection } from "./evidenceStore";

interface BlobCandidate {
  contentHash: string | null;
  blobPath: string | null;
}

export async function deleteConversationWithAttachments(
  db: DatabaseSync,
  store: ImageBlobStore,
  conversationId: string,
): Promise<boolean> {
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
    db.prepare("INSERT INTO conversation_event_deletion_authorizations (conversation_id) VALUES (?)")
      .run(conversationId);
    db.prepare("INSERT INTO evidence_deletion_authorizations (conversation_id) VALUES (?)").run(conversationId);
    db.prepare("DELETE FROM evidence_events WHERE conversation_id = ?").run(conversationId);
    releaseFusionRecoveriesOwnedByConversation(db, conversationId);
    db.prepare("DELETE FROM cad_gate_evidence WHERE conversation_id = ?").run(conversationId);
    db.prepare(`DELETE FROM headless_run_events WHERE run_id IN
      (SELECT id FROM headless_runs WHERE conversation_id = ?)` ).run(conversationId);
    db.prepare(`DELETE FROM headless_run_latest WHERE run_id IN
      (SELECT id FROM headless_runs WHERE conversation_id = ?)` ).run(conversationId);
    db.prepare("DELETE FROM agent_run_leases WHERE conversation_id = ?").run(conversationId);
    db.prepare("DELETE FROM headless_runs WHERE conversation_id = ?").run(conversationId);
    db.prepare("DELETE FROM fusion_inspections WHERE conversation_id = ?").run(conversationId);
    db.prepare("DELETE FROM fusion_document_bindings WHERE conversation_id = ?").run(conversationId);
    db.prepare(`DELETE FROM online_failure_signatures WHERE first_run_id IN
      (SELECT id FROM agent_runs WHERE conversation_id = ?)` ).run(conversationId);
    db.prepare(`DELETE FROM online_review_queue_refs WHERE run_id IN
      (SELECT id FROM agent_runs WHERE conversation_id = ?)` ).run(conversationId);
    db.prepare(`DELETE FROM online_review_inventory WHERE run_id IN
      (SELECT id FROM agent_runs WHERE conversation_id = ?)` ).run(conversationId);
    db.prepare(`DELETE FROM online_run_scores WHERE run_id IN
      (SELECT id FROM agent_runs WHERE conversation_id = ?)` ).run(conversationId);
    db.prepare("DELETE FROM agent_run_feedback WHERE conversation_id = ?").run(conversationId);
    db.prepare(`DELETE FROM agent_run_trace_refs WHERE run_id IN
      (SELECT id FROM agent_runs WHERE conversation_id = ?)` ).run(conversationId);
    db.prepare(`DELETE FROM agent_run_events WHERE run_id IN
      (SELECT id FROM agent_runs WHERE conversation_id = ?)` ).run(conversationId);
    db.prepare("DELETE FROM agent_runs WHERE conversation_id = ?").run(conversationId);
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
    db.prepare("DELETE FROM conversation_ui_projection WHERE conversation_id = ?").run(conversationId);
    db.prepare("DELETE FROM conversation_evidence_links WHERE conversation_id = ?").run(conversationId);
    db.prepare("DELETE FROM conversations WHERE id = ?").run(conversationId);
    db.prepare("DELETE FROM conversation_events WHERE conversation_id = ?").run(conversationId);
    db.prepare("DELETE FROM evidence_deletion_authorizations WHERE conversation_id = ?").run(conversationId);
    db.prepare("DELETE FROM conversation_event_deletion_authorizations WHERE conversation_id = ?")
      .run(conversationId);
    db.exec("COMMIT");
    invalidateConversationProjection(db, conversationId);
    invalidateEvidenceProjection(db, conversationId);
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
      await store.remove(blobPath);
    } catch {
      // Explicit or startup maintenance retries a failed post-commit removal.
    }
  }
  return true;
}
