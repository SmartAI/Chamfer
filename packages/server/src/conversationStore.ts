import type { DatabaseSync } from "node:sqlite";
import type { AttachmentDto, CadEnvironment, ConversationDto, Gate, MessageDto } from "@chamfer/shared";
import { createDesign } from "./designStore";
import { withImmediateTransaction } from "./dbTransaction";
import { ConversationEventStore } from "./conversationEventStore";

interface ConversationRow {
  id: string;
  title: string;
  cad_environment: CadEnvironment;
  created_at: number;
  updated_at: number;
  last_gate_status: string | null;
  source_specifications_required: number;
  design_id: string | null;
}

const GATE_STATUSES: ReadonlySet<string> = new Set(["passed", "failed", "error"]);

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
    designId: row.design_id,
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
  designId?: string,
  designName?: string,
): ConversationDto {
  const id = crypto.randomUUID();
  const now = Date.now();
  return withImmediateTransaction(db, () => {
    const boundDesignId = designId ?? createDesign(
      db,
      designName ?? (title === "New chat" ? "Untitled design" : title),
      cadEnvironment,
    ).id;
    new ConversationEventStore(db).append(id, {
      recordedAt: now,
      type: "conversation.created",
      data: {
        title,
        cadEnvironment,
        designId: boundDesignId,
        sourceSpecificationsRequired: true,
      },
    });
    return {
      id,
      title,
      designId: boundDesignId,
      cadEnvironment,
      createdAt: now,
      updatedAt: now,
      sourceSpecificationsRequired: true,
    };
  });
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
  if (!conversationExists(db, id)) return false;
  new ConversationEventStore(db).append(id, {
    type: "conversation.title-updated",
    data: { title },
  });
  return true;
}

export function createMessage(
  db: DatabaseSync,
  conversationId: string,
  message: { id: string; seq: number; role: string; contentJson: string },
): MessageDto {
  const now = Date.now();
  const dto = {
    id: message.id,
    conversationId,
    seq: message.seq,
    role: message.role,
    contentJson: message.contentJson,
    createdAt: now,
  };
  new ConversationEventStore(db).append(conversationId, {
    recordedAt: now,
    type: "message.appended",
    data: { message: dto, attachments: [] },
  });
  return dto;
}

export function listMessages(db: DatabaseSync, conversationId: string): MessageDto[] {
  const rows = db
    .prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq ASC")
    .all(conversationId) as unknown as MessageRow[];
  return rows.map(toMessageDto);
}

/** Highest stored message seq for the conversation; -1 for an empty
 * transcript. This is both the watermark of the container seed/transcript
 * protocol and the append cursor of turn persistence - one definition so the
 * two sides can never disagree. */
export function maxMessageSeq(db: DatabaseSync, conversationId: string): number {
  const row = db
    .prepare("SELECT COALESCE(MAX(seq), -1) AS max_seq FROM messages WHERE conversation_id = ?")
    .get(conversationId) as { max_seq: number };
  return row.max_seq;
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
  const attachment = {
    id,
    messageId,
    kind: kind as AttachmentDto["kind"],
    mime: blob.mime,
    contentHash: blob.contentHash,
    byteSize: blob.byteSize,
    displayOrder,
  };
  const row = db.prepare("SELECT conversation_id AS conversationId FROM messages WHERE id = ?")
    .get(messageId) as { conversationId: string } | undefined;
  if (!row) throw new Error("Message not found");
  new ConversationEventStore(db).append(row.conversationId, {
    type: "attachment.appended",
    data: { attachment: { ...attachment, blobPath: blob.blobPath } },
  });
  return attachment;
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
  const now = Date.now();
  const created: MessageDto = {
    id: message.id,
    conversationId,
    seq: message.seq,
    role: message.role,
    contentJson: message.contentJson,
    createdAt: now,
  };
  new ConversationEventStore(db).append(conversationId, {
    recordedAt: now,
    type: "message.appended",
    data: {
      message: created,
      attachments: attachments.map((attachment, displayOrder) => ({
        id: attachment.id,
        messageId: message.id,
        kind: attachment.kind as AttachmentDto["kind"],
        mime: attachment.blob.mime,
        contentHash: attachment.blob.contentHash,
        byteSize: attachment.blob.byteSize,
        blobPath: attachment.blob.blobPath,
        displayOrder,
      })),
    },
  });
  return created;
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
