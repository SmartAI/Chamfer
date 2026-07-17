import type { DatabaseSync } from "node:sqlite";
import type { AttachmentDto, CadEnvironment, ConversationDto, Gate, MessageDto } from "@chamfer/shared";

interface ConversationRow {
  id: string;
  title: string;
  cad_environment: CadEnvironment;
  created_at: number;
  updated_at: number;
  last_gate_status: string | null;
  source_specifications_required: number;
}

const GATE_STATUSES: ReadonlySet<string> = new Set(["passed", "failed", "error"]);

/** Verify-gate verdict carried by a toolResult message's contentJson, or undefined.
 * Tolerates any malformed input: rollup extraction must never block persistence. */
function gateStatusOf(role: string, contentJson: string): Gate["status"] | undefined {
  if (role !== "toolResult") return undefined;
  try {
    const parsed = JSON.parse(contentJson) as { details?: { gate?: { status?: unknown } } };
    const status = parsed?.details?.gate?.status;
    return typeof status === "string" && GATE_STATUSES.has(status) ? (status as Gate["status"]) : undefined;
  } catch {
    return undefined;
  }
}

interface MessageRow {
  id: string;
  conversation_id: string;
  seq: number;
  role: string;
  content_json: string;
  created_at: number;
}

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
}

function toConversationDto(row: ConversationRow): ConversationDto {
  return {
    id: row.id,
    title: row.title,
    cadEnvironment: row.cad_environment,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sourceSpecificationsRequired: row.source_specifications_required === 1,
    ...(row.last_gate_status && GATE_STATUSES.has(row.last_gate_status)
      ? { lastGateStatus: row.last_gate_status as Gate["status"] }
      : {}),
  };
}

function toMessageDto(row: MessageRow): MessageDto {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    seq: row.seq,
    role: row.role,
    contentJson: row.content_json,
    createdAt: row.created_at,
  };
}

function toAttachmentDto(row: AttachmentRow): AttachmentDto {
  return {
    id: row.id,
    messageId: row.message_id,
    kind: row.kind as AttachmentDto["kind"],
    mime: row.mime,
    contentHash: row.content_hash ?? "",
    byteSize: row.byte_size ?? row.data?.byteLength ?? 0,
    displayOrder: row.display_order ?? 0,
  };
}

export function createConversation(
  db: DatabaseSync,
  title: string,
  cadEnvironment: CadEnvironment = "build123d",
): ConversationDto {
  const id = crypto.randomUUID();
  const now = Date.now();
  db.prepare(
    "INSERT INTO conversations (id, title, cad_environment, created_at, updated_at, source_specifications_required) VALUES (?, ?, ?, ?, ?, 1)",
  ).run(
    id,
    title,
    cadEnvironment,
    now,
    now,
  );
  return { id, title, cadEnvironment, createdAt: now, updatedAt: now, sourceSpecificationsRequired: true };
}

export function getConversation(db: DatabaseSync, id: string): ConversationDto | undefined {
  const row = db.prepare("SELECT * FROM conversations WHERE id = ?").get(id) as unknown as
    | ConversationRow
    | undefined;
  return row ? toConversationDto(row) : undefined;
}

export function listConversations(db: DatabaseSync): ConversationDto[] {
  const rows = db.prepare("SELECT * FROM conversations ORDER BY updated_at DESC").all() as unknown as ConversationRow[];
  return rows.map(toConversationDto);
}

export function conversationExists(db: DatabaseSync, id: string): boolean {
  const row = db.prepare("SELECT 1 FROM conversations WHERE id = ?").get(id);
  return row !== undefined;
}

export function messageExists(db: DatabaseSync, id: string): boolean {
  const row = db.prepare("SELECT 1 FROM messages WHERE id = ?").get(id);
  return row !== undefined;
}

export function getMessage(db: DatabaseSync, id: string): MessageDto | undefined {
  const row = db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as unknown as MessageRow | undefined;
  return row ? toMessageDto(row) : undefined;
}

/** Internal-only title setter: titles are server-generated (see routes'
 * generate-title); there is no user-facing rename endpoint. */
export function setConversationTitle(db: DatabaseSync, id: string, title: string): boolean {
  const result = db.prepare("UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?").run(
    title,
    Date.now(),
    id,
  );
  return result.changes > 0;
}

export function createMessage(
  db: DatabaseSync,
  conversationId: string,
  message: { id: string; seq: number; role: string; contentJson: string },
): MessageDto {
  const now = Date.now();
  db.prepare(
    "INSERT INTO messages (id, conversation_id, seq, role, content_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(message.id, conversationId, message.seq, message.role, message.contentJson, now);
  db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(now, conversationId);
  const gateStatus = gateStatusOf(message.role, message.contentJson);
  if (gateStatus) {
    db.prepare("UPDATE conversations SET last_gate_status = ? WHERE id = ?").run(gateStatus, conversationId);
  }
  return {
    id: message.id,
    conversationId,
    seq: message.seq,
    role: message.role,
    contentJson: message.contentJson,
    createdAt: now,
  };
}

export function listMessages(db: DatabaseSync, conversationId: string): MessageDto[] {
  const rows = db
    .prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq ASC")
    .all(conversationId) as unknown as MessageRow[];
  return rows.map(toMessageDto);
}

export function createAttachment(
  db: DatabaseSync,
  messageId: string,
  kind: string,
  blob: { mime: string; contentHash: string; byteSize: number; blobPath: string },
  id: string = crypto.randomUUID(),
): AttachmentDto {
  const orderRow = db.prepare(
    "SELECT COALESCE(MAX(display_order), -1) + 1 AS display_order FROM attachments WHERE message_id = ?",
  ).get(messageId) as { display_order: number };
  const displayOrder = orderRow.display_order;
  db.prepare(
    `INSERT INTO attachments
      (id, message_id, kind, mime, content_hash, byte_size, blob_path, display_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    messageId,
    kind,
    blob.mime,
    blob.contentHash,
    blob.byteSize,
    blob.blobPath,
    displayOrder,
  );
  return {
    id,
    messageId,
    kind: kind as AttachmentDto["kind"],
    mime: blob.mime,
    contentHash: blob.contentHash,
    byteSize: blob.byteSize,
    displayOrder,
  };
}

export function createMessageWithAttachments(
  db: DatabaseSync,
  conversationId: string,
  message: { id: string; seq: number; role: string; contentJson: string },
  attachments: Array<{
    id: string;
    kind: string;
    blob: { mime: string; contentHash: string; byteSize: number; blobPath: string };
  }>,
): MessageDto {
  db.exec("BEGIN IMMEDIATE");
  try {
    const created = createMessage(db, conversationId, message);
    for (const attachment of attachments) {
      createAttachment(db, message.id, attachment.kind, attachment.blob, attachment.id);
    }
    db.exec("COMMIT");
    return created;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function getAttachment(db: DatabaseSync, id: string):
  | { storage: "blob"; mime: string; contentHash: string; byteSize: number; blobPath: string }
  | { storage: "legacy"; mime: string; data: Uint8Array }
  | undefined {
  const hasLegacyData = (db.prepare("PRAGMA table_info(attachments)").all() as Array<{ name: string }>).some(
    (column) => column.name === "data",
  );
  const row = db.prepare(
    `SELECT mime, ${hasLegacyData ? "data" : "NULL AS data"}, content_hash, byte_size, blob_path
       FROM attachments WHERE id = ?`,
  ).get(id) as
    | {
        mime: string;
        data: Uint8Array | null;
        content_hash: string | null;
        byte_size: number | null;
        blob_path: string | null;
      }
    | undefined;
  if (!row) return undefined;
  if (row.content_hash !== null && row.byte_size !== null && row.blob_path !== null) {
    return {
      storage: "blob",
      mime: row.mime,
      contentHash: row.content_hash,
      byteSize: row.byte_size,
      blobPath: row.blob_path,
    };
  }
  // Direct API tests can create a pre-startup database; production startup removes this column.
  return row.data === null ? undefined : { storage: "legacy", mime: row.mime, data: row.data };
}

export function attachmentReferenceCount(db: DatabaseSync, contentHash: string): number {
  const row = db.prepare("SELECT COUNT(*) AS count FROM attachments WHERE content_hash = ?").get(contentHash) as {
    count: number;
  };
  return row.count;
}

export function listAttachments(db: DatabaseSync, messageId: string): AttachmentDto[] {
  const rows = db.prepare(
    "SELECT * FROM attachments WHERE message_id = ? ORDER BY display_order ASC, rowid ASC",
  ).all(messageId) as unknown as AttachmentRow[];
  return rows.map(toAttachmentDto);
}
