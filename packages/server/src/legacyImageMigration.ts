import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { AttachmentStorageError, AttachmentStore, type StoredImageBlob } from "./attachmentStore";

const MIGRATION_VERSION = 1;
const ATTACHMENT_KINDS = new Set(["user-image", "view-sheet"]);

interface AttachmentRow {
  id: string;
  message_id: string;
  kind: string;
  mime: string;
  data: Uint8Array | null;
  content_hash: string | null;
  byte_size: number | null;
  blob_path: string | null;
  display_order: number | null;
  migration_state: string | null;
  migration_error: string | null;
}

interface InlineImage {
  type: "image";
  data: string;
  mimeType: string;
}

interface AttachmentReference {
  type: "attachment-reference";
  attachmentId: string;
}

export interface LegacyImageMigrationReport {
  migrated: number;
  broken: number;
  normalizedMessages: number;
  diagnostics: Array<{ attachmentId: string; messageId: string; code: string }>;
  alreadyComplete: boolean;
}

export interface LegacyImageMigrationOptions {
  /** Test-only crash seam after durable verification and before the metadata link. */
  afterBlobVerified?: (attachmentId: string, blob: StoredImageBlob) => void | Promise<void>;
}

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(
    (candidate) => candidate.name === column,
  );
}

function ensureMigrationSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS image_migration_versions (
      version INTEGER PRIMARY KEY,
      completed_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS image_migration_diagnostics (
      attachment_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      code TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (attachment_id, code)
    );
  `);
  if (!hasColumn(db, "attachments", "migration_state")) {
    db.exec("ALTER TABLE attachments ADD COLUMN migration_state TEXT");
  }
  if (!hasColumn(db, "attachments", "migration_error")) {
    db.exec("ALTER TABLE attachments ADD COLUMN migration_error TEXT");
  }
  db.exec(`
    UPDATE attachments
       SET migration_state = CASE
         WHEN content_hash IS NOT NULL AND byte_size IS NOT NULL AND blob_path IS NOT NULL THEN 'migrated'
         ELSE 'pending'
       END
     WHERE migration_state IS NULL;
  `);

  const messages = db.prepare("SELECT DISTINCT message_id FROM attachments").all() as Array<{ message_id: string }>;
  const rowsForMessage = db.prepare(
    "SELECT id FROM attachments WHERE message_id = ? ORDER BY CASE WHEN display_order IS NULL THEN 1 ELSE 0 END, display_order, rowid",
  );
  const setOrder = db.prepare("UPDATE attachments SET display_order = ? WHERE id = ? AND display_order IS NULL");
  for (const { message_id } of messages) {
    const rows = rowsForMessage.all(message_id) as Array<{ id: string }>;
    rows.forEach((row, index) => setOrder.run(index, row.id));
  }
}

function migrationComplete(db: DatabaseSync): boolean {
  return db.prepare("SELECT 1 FROM image_migration_versions WHERE version = ?").get(MIGRATION_VERSION) !== undefined;
}

function strictBase64(value: unknown): Uint8Array | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0) return undefined;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return undefined;
  return Buffer.from(value, "base64");
}

function isInlineImage(value: unknown): value is InlineImage {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<InlineImage>;
  return candidate.type === "image" && typeof candidate.data === "string" && typeof candidate.mimeType === "string";
}

function isAttachmentReference(value: unknown): value is AttachmentReference {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<AttachmentReference>;
  return candidate.type === "attachment-reference" && typeof candidate.attachmentId === "string";
}

function imageKind(role: string): "user-image" | "view-sheet" {
  return role === "toolResult" ? "view-sheet" : "user-image";
}

function recoveredAttachmentId(messageId: string, contentIndex: number): string {
  return `legacy-${createHash("sha256").update(`${messageId}:${contentIndex}`).digest("hex").slice(0, 24)}`;
}

function attachmentRows(db: DatabaseSync, messageId: string, kind?: string): AttachmentRow[] {
  const query = kind
    ? "SELECT * FROM attachments WHERE message_id = ? AND kind = ? ORDER BY display_order, rowid"
    : "SELECT * FROM attachments WHERE message_id = ? ORDER BY display_order, rowid";
  return db.prepare(query).all(...(kind ? [messageId, kind] : [messageId])) as unknown as AttachmentRow[];
}

function recordBroken(
  db: DatabaseSync,
  row: Pick<AttachmentRow, "id" | "message_id">,
  code: string,
  report: LegacyImageMigrationReport,
): void {
  db.prepare("UPDATE attachments SET migration_state = 'broken', migration_error = ? WHERE id = ?").run(code, row.id);
  db.prepare(
    "INSERT OR IGNORE INTO image_migration_diagnostics (attachment_id, message_id, code, created_at) VALUES (?, ?, ?, ?)",
  ).run(row.id, row.message_id, code, Date.now());
  report.broken += 1;
  report.diagnostics.push({ attachmentId: row.id, messageId: row.message_id, code });
}

async function linkBlob(
  db: DatabaseSync,
  store: AttachmentStore,
  row: AttachmentRow,
  bytes: Uint8Array,
  mime: string,
  report: LegacyImageMigrationReport,
  options: LegacyImageMigrationOptions,
): Promise<boolean> {
  let blob: StoredImageBlob;
  try {
    blob = await store.write(bytes, mime);
    await store.read(blob);
  } catch (error) {
    const code = error instanceof AttachmentStorageError ? error.code : "write-failed";
    recordBroken(db, row, code, report);
    return false;
  }
  await options.afterBlobVerified?.(row.id, blob);
  db.prepare(
    `UPDATE attachments
        SET mime = ?, data = NULL, content_hash = ?, byte_size = ?, blob_path = ?,
            migration_state = 'migrated', migration_error = NULL
      WHERE id = ?`,
  ).run(blob.mime, blob.contentHash, blob.byteSize, blob.blobPath, row.id);
  report.migrated += 1;
  return true;
}

async function migrateRow(
  db: DatabaseSync,
  store: AttachmentStore,
  row: AttachmentRow,
  inline: InlineImage | undefined,
  report: LegacyImageMigrationReport,
  options: LegacyImageMigrationOptions,
): Promise<boolean> {
  if (row.migration_state === "migrated" && row.content_hash && row.byte_size !== null && row.blob_path) {
    try {
      await store.read({
        contentHash: row.content_hash,
        byteSize: row.byte_size,
        mime: row.mime,
        blobPath: row.blob_path,
      });
      return true;
    } catch (error) {
      const code = error instanceof AttachmentStorageError ? error.code : "corrupt";
      recordBroken(db, row, code, report);
      return false;
    }
  }

  if (!ATTACHMENT_KINDS.has(row.kind)) {
    recordBroken(db, row, "unsupported-kind", report);
    return false;
  }

  const inlineBytes = inline ? strictBase64(inline.data) : undefined;
  if (inline && !inlineBytes) {
    recordBroken(db, row, "invalid-base64", report);
    return false;
  }
  if (inline && inline.mimeType !== row.mime) {
    recordBroken(db, row, "conflicting-media", report);
    return false;
  }
  if (row.data && inlineBytes && !Buffer.from(row.data).equals(Buffer.from(inlineBytes))) {
    recordBroken(db, row, "conflicting-bytes", report);
    return false;
  }

  const bytes = row.data ?? inlineBytes;
  if (!bytes) {
    recordBroken(db, row, "missing-source-bytes", report);
    return false;
  }
  return linkBlob(db, store, row, bytes, row.mime, report, options);
}

function insertRecoveredRow(
  db: DatabaseSync,
  messageId: string,
  contentIndex: number,
  kind: string,
  mime: string,
): AttachmentRow {
  const id = recoveredAttachmentId(messageId, contentIndex);
  const order = (db.prepare(
    "SELECT COALESCE(MAX(display_order), -1) + 1 AS value FROM attachments WHERE message_id = ?",
  ).get(messageId) as { value: number }).value;
  db.prepare(
    `INSERT OR IGNORE INTO attachments
      (id, message_id, kind, mime, data, display_order, migration_state)
      VALUES (?, ?, ?, ?, NULL, ?, 'pending')`,
  ).run(id, messageId, kind, mime, order);
  return db.prepare("SELECT * FROM attachments WHERE id = ?").get(id) as unknown as AttachmentRow;
}

function removeLegacyDataColumn(db: DatabaseSync): void {
  if (!hasColumn(db, "attachments", "data")) return;
  db.exec("ALTER TABLE attachments DROP COLUMN data");
}

export async function migrateLegacyImages(
  db: DatabaseSync,
  store: AttachmentStore,
  options: LegacyImageMigrationOptions = {},
): Promise<LegacyImageMigrationReport> {
  ensureMigrationSchema(db);
  const report: LegacyImageMigrationReport = {
    migrated: 0,
    broken: 0,
    normalizedMessages: 0,
    diagnostics: [],
    alreadyComplete: migrationComplete(db),
  };
  if (report.alreadyComplete) return report;

  const messages = db.prepare("SELECT id, role, content_json FROM messages ORDER BY conversation_id, seq").all() as Array<{
    id: string;
    role: string;
    content_json: string;
  }>;
  const processed = new Set<string>();

  for (const message of messages) {
    let parsed: { content?: unknown };
    try {
      parsed = JSON.parse(message.content_json) as { content?: unknown };
    } catch {
      continue;
    }
    if (!Array.isArray(parsed.content)) continue;

    const kind = imageKind(message.role);
    const referencedAttachmentIds = new Set(parsed.content.filter(isAttachmentReference).map((block) => block.attachmentId));
    const candidates = attachmentRows(db, message.id, kind).filter((row) => !referencedAttachmentIds.has(row.id));
    let imageOrdinal = 0;
    let changed = false;
    const normalized = [];
    for (let contentIndex = 0; contentIndex < parsed.content.length; contentIndex += 1) {
      const block = parsed.content[contentIndex];
      if (!isInlineImage(block)) {
        normalized.push(block);
        continue;
      }
      const row = candidates[imageOrdinal] ?? insertRecoveredRow(db, message.id, contentIndex, kind, block.mimeType);
      imageOrdinal += 1;
      const migrated = await migrateRow(db, store, row, block, report, options);
      processed.add(row.id);
      if (migrated) {
        normalized.push({
          type: "attachment-reference",
          attachmentId: row.id,
          kind,
          mimeType: block.mimeType,
        });
        changed = true;
      } else {
        normalized.push(block);
      }
    }
    if (changed) {
      parsed.content = normalized;
      db.prepare("UPDATE messages SET content_json = ? WHERE id = ?").run(JSON.stringify(parsed), message.id);
      report.normalizedMessages += 1;
    }
  }

  const remaining = db.prepare("SELECT * FROM attachments ORDER BY message_id, display_order, rowid").all() as unknown as AttachmentRow[];
  for (const row of remaining) {
    if (!processed.has(row.id)) await migrateRow(db, store, row, undefined, report, options);
  }

  const nonterminal = db.prepare(
    "SELECT COUNT(*) AS count FROM attachments WHERE migration_state != 'migrated' OR migration_state IS NULL",
  ).get() as { count: number };
  if (nonterminal.count === 0) {
    removeLegacyDataColumn(db);
    db.prepare("INSERT OR REPLACE INTO image_migration_versions (version, completed_at) VALUES (?, ?)").run(
      MIGRATION_VERSION,
      Date.now(),
    );
  }
  return report;
}
