import type { DatabaseSync } from "node:sqlite";
import { AttachmentStore } from "./attachmentStore";
import { runAttachmentMaintenance } from "./attachmentMaintenance";
import { migrateLegacyImages } from "./legacyImageMigration";
import { refreshLegacyConversationEventLogs } from "./conversationEventStore";

export async function prepareImageStorage(db: DatabaseSync, dataDir: string) {
  const store = new AttachmentStore(dataDir);
  const migration = await migrateLegacyImages(db, store);
  if (migration.migrated > 0 || migration.normalizedMessages > 0) {
    refreshLegacyConversationEventLogs(db);
  }
  const maintenance = await runAttachmentMaintenance(db, store);
  return { migration, maintenance };
}
