import type { DatabaseSync } from "node:sqlite";
import { AttachmentStore } from "./attachmentStore";
import { runAttachmentMaintenance } from "./attachmentMaintenance";
import { migrateLegacyImages } from "./legacyImageMigration";

export async function prepareImageStorage(db: DatabaseSync, dataDir: string) {
  const store = new AttachmentStore(dataDir);
  const migration = await migrateLegacyImages(db, store);
  const maintenance = runAttachmentMaintenance(db, store);
  return { migration, maintenance };
}
