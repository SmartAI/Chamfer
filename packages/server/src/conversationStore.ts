import type { DatabaseSync } from "node:sqlite";
import type { AttachmentDto, ConversationDto, Gate, MessageDto } from "@chamfer/shared";

interface ConversationRow {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  last_gate_status: string | null;
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
  data: Uint8Array;
}

function toConversationDto(row: ConversationRow): ConversationDto {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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
  };
}

export function createConversation(db: DatabaseSync, title: string): ConversationDto {
  const id = crypto.randomUUID();
  const now = Date.now();
  db.prepare("INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)").run(
    id,
    title,
    now,
    now,
  );
  return { id, title, createdAt: now, updatedAt: now };
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

export function deleteConversation(db: DatabaseSync, id: string): boolean {
  if (!conversationExists(db, id)) return false;
  db.prepare(
    `DELETE FROM attachments WHERE message_id IN (SELECT id FROM messages WHERE conversation_id = ?)`,
  ).run(id);
  db.prepare("DELETE FROM messages WHERE conversation_id = ?").run(id);
  db.prepare("DELETE FROM artifacts WHERE conversation_id = ?").run(id);
  db.prepare("DELETE FROM conversations WHERE id = ?").run(id);
  return true;
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
  mime: string,
  data: Uint8Array,
): AttachmentDto {
  const id = crypto.randomUUID();
  db.prepare("INSERT INTO attachments (id, message_id, kind, mime, data) VALUES (?, ?, ?, ?, ?)").run(
    id,
    messageId,
    kind,
    mime,
    data,
  );
  return { id, messageId, kind: kind as AttachmentDto["kind"], mime };
}

export function getAttachment(db: DatabaseSync, id: string): { mime: string; data: Uint8Array } | undefined {
  const row = db.prepare("SELECT mime, data FROM attachments WHERE id = ?").get(id) as
    | { mime: string; data: Uint8Array }
    | undefined;
  if (!row) return undefined;
  return { mime: row.mime, data: row.data };
}

export function listAttachments(db: DatabaseSync, messageId: string): AttachmentDto[] {
  const rows = db.prepare("SELECT * FROM attachments WHERE message_id = ? ORDER BY rowid ASC").all(messageId) as unknown as AttachmentRow[];
  return rows.map(toAttachmentDto);
}
