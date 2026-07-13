import type { DatabaseSync } from "node:sqlite";
import {
  AttachmentStore,
  type AttachmentFileMaintenanceReport,
  type AttachmentMaintenanceOptions,
} from "./attachmentStore";

export interface AttachmentMetadataReference {
  attachmentId: string;
  contentHash: string;
  blobPath: string;
}

export interface AttachmentMaintenanceReport extends AttachmentFileMaintenanceReport {
  metadataBefore: AttachmentMetadataReference[];
  metadataAfter: AttachmentMetadataReference[];
}

function metadataInventory(db: DatabaseSync): AttachmentMetadataReference[] {
  const rows = db.prepare(
    `SELECT id AS attachmentId, content_hash AS contentHash, blob_path AS blobPath
       FROM attachments
      WHERE content_hash IS NOT NULL OR blob_path IS NOT NULL
      ORDER BY id`,
  ).all() as unknown as Array<{ attachmentId: string; contentHash: string | null; blobPath: string | null }>;
  const references: AttachmentMetadataReference[] = [];
  for (const row of rows) {
    if (!row.contentHash && !row.blobPath) continue;
    const blobPath = row.blobPath ?? `images/${row.contentHash!.slice(0, 2)}/${row.contentHash}`;
    const contentHash = row.contentHash ?? "";
    references.push({ attachmentId: row.attachmentId, contentHash, blobPath });
  }
  return references;
}

export function runAttachmentMaintenance(
  db: DatabaseSync,
  store: AttachmentStore,
  options: AttachmentMaintenanceOptions = {},
): AttachmentMaintenanceReport {
  const metadataBefore = metadataInventory(db);
  const referencedPaths = new Set<string>();
  for (const reference of metadataBefore) {
    referencedPaths.add(reference.blobPath);
    if (reference.contentHash) {
      referencedPaths.add(`images/${reference.contentHash.slice(0, 2)}/${reference.contentHash}`);
    }
  }
  const fileReport = store.maintain(referencedPaths, options);
  return { metadataBefore, metadataAfter: metadataInventory(db), ...fileReport };
}
