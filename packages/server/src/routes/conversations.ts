import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import { DEFAULT_CONVERSATION_TITLE, type AttachmentReferenceBlock, type GenerateTitleDto } from "@chamfer/shared";
import {
  conversationExists,
  attachmentReferenceCount,
  createAttachment,
  createConversation,
  createMessage,
  createMessageWithAttachments,
  getAttachment,
  getMessage,
  getConversation,
  listConversations,
  listAttachments,
  listMessages,
  messageExists,
  setConversationTitle,
} from "../conversationStore";
import { AttachmentStorageError, AttachmentStore, type StoredImageBlob } from "../attachmentStore";
import { readEffectiveSettings } from "../settingsStore";
import { resolveProviderConfig } from "../providerConfig";
import { buildTitleTranscript, generateTitleText } from "../titles";
import type { LlmStreamer } from "../llm";
import { deleteConversationWithAttachments } from "../conversationDeletion";

const VALID_ATTACHMENT_KINDS = new Set(["user-image", "view-sheet"]);

const SQLITE_CONSTRAINT_UNIQUE = 2067;

function isUniqueConstraintError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const errcode = (err as { errcode?: number }).errcode;
  if (errcode === SQLITE_CONSTRAINT_UNIQUE) return true;
  return err.message.includes("UNIQUE constraint failed");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAttachmentReference(value: unknown): value is AttachmentReferenceBlock {
  if (typeof value !== "object" || value === null) return false;
  const block = value as Partial<AttachmentReferenceBlock>;
  return block.type === "attachment-reference" && typeof block.attachmentId === "string" &&
    (block.kind === "user-image" || block.kind === "view-sheet") && typeof block.mimeType === "string";
}

interface AtomicAttachmentInput {
  id: string;
  kind: "user-image" | "view-sheet";
  mime: string;
  data: string;
}

function validateAtomicMessage(
  role: string,
  contentJson: string,
  attachments: AtomicAttachmentInput[],
): { references: AttachmentReferenceBlock[] } | { error: string } {
  let message: Record<string, unknown>;
  try {
    message = JSON.parse(contentJson) as Record<string, unknown>;
  } catch {
    return { error: "invalid content JSON" };
  }
  if (!isRecord(message) || message.role !== role || !Array.isArray(message.content)) {
    return { error: "normalized message role and content are invalid" };
  }
  if (message.content.some((block) => isRecord(block) && block.type === "image")) {
    return { error: "native image blocks cannot be persisted" };
  }
  const references = message.content.filter(isAttachmentReference);
  if (references.length !== attachments.length || references.length === 0 ||
      new Set(references.map((reference) => reference.attachmentId)).size !== references.length) {
    return { error: "normalized references must exactly match unique attachment payloads" };
  }
  for (let index = 0; index < references.length; index += 1) {
    const reference = references[index]!;
    const attachment = attachments[index];
    if (!attachment || reference.attachmentId !== attachment.id || reference.kind !== attachment.kind ||
        reference.mimeType !== attachment.mime) {
      return { error: "attachment metadata does not match normalized references" };
    }
  }
  const viewSheets = references.filter((reference) => reference.kind === "view-sheet");
  if (message.role === "toolResult" && message.toolName === "run_build123d") {
    if (viewSheets.length !== 1 || !isRecord(message.details) || !isRecord(message.details.inspectionSheet)) {
      return { error: "CAD image messages require one derived inspection sheet" };
    }
    const expectedSheet = {
      attachmentId: viewSheets[0]!.attachmentId,
      code: message.details.code,
      measurements: message.details.measurements,
      ...(message.details.gate ? { gate: message.details.gate } : {}),
    };
    if (JSON.stringify(message.details.inspectionSheet) !== JSON.stringify(expectedSheet)) {
      return { error: "inspection sheet metadata must derive from the CAD result" };
    }
  } else if (viewSheets.length > 0) {
    return { error: "view sheets can only belong to CAD results" };
  }
  return { references };
}

function decodeBase64(data: string): Buffer | undefined {
  if (data.length === 0 || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return undefined;
  const decoded = Buffer.from(data, "base64");
  return decoded.toString("base64") === data ? decoded : undefined;
}

function sameAtomicCommit(
  existing: ReturnType<typeof getMessage>,
  conversationId: string,
  message: { id: string; seq: number; role: string; contentJson: string },
  attachments: AtomicAttachmentInput[],
  blobs: StoredImageBlob[],
  committedAttachments: ReturnType<typeof listAttachments>,
): boolean {
  return !!existing && existing.conversationId === conversationId && existing.id === message.id &&
    existing.seq === message.seq && existing.role === message.role && existing.contentJson === message.contentJson &&
    committedAttachments.length === attachments.length && committedAttachments.every((committed, index) => {
      const input = attachments[index]!;
      const blob = blobs[index]!;
      return committed.id === input.id && committed.kind === input.kind && committed.mime === input.mime &&
        committed.contentHash === blob.contentHash && committed.byteSize === blob.byteSize && committed.displayOrder === index;
    });
}

export function conversationsRoutes(db: DatabaseSync, llm: LlmStreamer, attachmentStore: AttachmentStore): Hono {
  const app = new Hono();

  app.post("/api/conversations", async (c) => {
    const { title } = (await c.req.json()) as { title: string };
    const conversation = createConversation(db, title);
    return c.json(conversation);
  });

  app.get("/api/conversations", (c) => {
    return c.json(listConversations(db));
  });

  app.post("/api/conversations/:id/generate-title", async (c) => {
    const id = c.req.param("id");
    const conversation = getConversation(db, id);
    if (!conversation) return c.json({ error: "not found" }, 404);
    // Idempotent: anything other than the creation default is an earlier
    // successful generation and is left untouched.
    if (conversation.title !== DEFAULT_CONVERSATION_TITLE) {
      return c.json({ title: conversation.title, generated: false } satisfies GenerateTitleDto);
    }
    const { settings } = readEffectiveSettings(db);
    if (!settings.modelJson) return c.json({ error: "no model configured" }, 400);
    const transcript = buildTitleTranscript(listMessages(db, id));
    if (!transcript) {
      return c.json({ title: conversation.title, generated: false } satisfies GenerateTitleDto);
    }
    const model = JSON.parse(settings.modelJson) as unknown;
    const { requestModel, apiKey, env } = resolveProviderConfig(settings, model);
    let title: string;
    try {
      title = await generateTitleText(llm, requestModel, transcript, { apiKey, env, sessionId: id });
    } catch (err) {
      // Only the error's own message is forwarded, mirroring /api/stream: no
      // options/env, so key material can't leak into the response body.
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
    if (!title) return c.json({ error: "model returned no usable title" }, 502);
    setConversationTitle(db, id, title);
    return c.json({ title, generated: true } satisfies GenerateTitleDto);
  });

  app.delete("/api/conversations/:id", (c) => {
    const deleted = deleteConversationWithAttachments(db, attachmentStore, c.req.param("id"));
    if (!deleted) return c.json({ error: "not found" }, 404);
    return c.json({ ok: true });
  });

  app.post("/api/conversations/:id/messages", async (c) => {
    const conversationId = c.req.param("id");
    if (!conversationExists(db, conversationId)) return c.json({ error: "not found" }, 404);
    const body = (await c.req.json()) as { id: string; seq: number; role: string; contentJson: string };
    try {
      const message = createMessage(db, conversationId, body);
      return c.json(message);
    } catch (err) {
      if (isUniqueConstraintError(err)) return c.json({ error: "duplicate seq" }, 409);
      throw err;
    }
  });

  app.post("/api/conversations/:id/messages-with-attachments", async (c) => {
    const conversationId = c.req.param("id");
    if (!conversationExists(db, conversationId)) return c.json({ error: "not found" }, 404);
    const body = (await c.req.json()) as {
      message?: { id?: unknown; seq?: unknown; role?: unknown; contentJson?: unknown };
      attachments?: unknown;
    };
    const candidate = body.message;
    if (!candidate || typeof candidate.id !== "string" || typeof candidate.seq !== "number" ||
        !Number.isInteger(candidate.seq) || typeof candidate.role !== "string" ||
        typeof candidate.contentJson !== "string" || !Array.isArray(body.attachments)) {
      return c.json({ error: "invalid atomic message request" }, 400);
    }
    const attachments = body.attachments as AtomicAttachmentInput[];
    if (attachments.some((attachment) => !isRecord(attachment) || typeof attachment.id !== "string" ||
        (attachment.kind !== "user-image" && attachment.kind !== "view-sheet") ||
        typeof attachment.mime !== "string" || typeof attachment.data !== "string")) {
      return c.json({ error: "invalid attachment payload" }, 400);
    }
    const validation = validateAtomicMessage(candidate.role, candidate.contentJson, attachments);
    if ("error" in validation) return c.json({ error: validation.error }, 409);

    const blobs: StoredImageBlob[] = [];
    const created = new Map<string, StoredImageBlob>();
    const cleanup = () => {
      for (const blob of created.values()) {
        if (attachmentReferenceCount(db, blob.contentHash) !== 0) continue;
        try {
          attachmentStore.remove(blob.blobPath);
        } catch {
          // Startup maintenance reclaims crash and cleanup-failure orphans.
        }
      }
    };
    try {
      for (const attachment of attachments) {
        const decoded = decodeBase64(attachment.data);
        if (!decoded) {
          cleanup();
          return c.json({ error: "invalid base64 attachment data" }, 400);
        }
        const blob = await attachmentStore.write(decoded, attachment.mime);
        blobs.push(blob);
        if (blob.created) created.set(blob.blobPath, blob);
      }
    } catch (error) {
      cleanup();
      if (error instanceof AttachmentStorageError) {
        const status = error.code === "unsupported-media" ? 415 : error.code === "corrupt" ? 422 : 500;
        return c.json({ error: error.code }, status);
      }
      throw error;
    }

    const message = candidate as { id: string; seq: number; role: string; contentJson: string };
    const existing = getMessage(db, message.id);
    if (existing) {
      const exact = sameAtomicCommit(
        existing, conversationId, message, attachments, blobs, listAttachments(db, message.id),
      );
      cleanup();
      return exact ? c.json(existing) : c.json({ error: "atomic message retry conflicts with committed data" }, 409);
    }
    try {
      return c.json(createMessageWithAttachments(
        db,
        conversationId,
        message,
        attachments.map((attachment, index) => ({ id: attachment.id, kind: attachment.kind, blob: blobs[index]! })),
      ));
    } catch (error) {
      cleanup();
      if (isUniqueConstraintError(error)) return c.json({ error: "atomic message conflicts with committed data" }, 409);
      throw error;
    }
  });

  app.get("/api/conversations/:id/messages", (c) => {
    return c.json(listMessages(db, c.req.param("id")));
  });

  app.post("/api/messages/:id/attachments", async (c) => {
    const messageId = c.req.param("id");
    if (!messageExists(db, messageId)) return c.json({ error: "not found" }, 404);
    const kind = c.req.query("kind") ?? "";
    if (!VALID_ATTACHMENT_KINDS.has(kind)) return c.json({ error: "invalid kind" }, 400);
    const mime = c.req.query("mime") ?? "";
    const attachmentId = c.req.query("id") || undefined;
    const buffer = await c.req.arrayBuffer();
    let blob;
    try {
      blob = await attachmentStore.write(Buffer.from(buffer), mime);
      try {
        return c.json(createAttachment(db, messageId, kind, blob, attachmentId));
      } catch (error) {
        const existing = attachmentId
          ? listAttachments(db, messageId).find((attachment) => attachment.id === attachmentId)
          : undefined;
        if (existing && existing.kind === kind && existing.mime === blob.mime &&
            existing.contentHash === blob.contentHash && existing.byteSize === blob.byteSize) {
          return c.json(existing);
        }
        if (blob.created && attachmentReferenceCount(db, blob.contentHash) === 0) {
          try {
            attachmentStore.remove(blob.blobPath);
          } catch {
            // Startup maintenance can reclaim a blob if best-effort cleanup fails.
          }
        }
        throw error;
      }
    } catch (error) {
      if (error instanceof AttachmentStorageError) {
        const status =
          error.code === "missing"
            ? 404
            : error.code === "unsupported-media"
              ? 415
              : error.code === "corrupt" || error.code === "path-rejected"
                ? 422
                : 500;
        return c.json({ error: error.code }, status);
      }
      throw error;
    }
  });

  app.get("/api/messages/:id/attachments", (c) => {
    const messageId = c.req.param("id");
    if (!messageExists(db, messageId)) return c.json({ error: "not found" }, 404);
    return c.json(listAttachments(db, messageId));
  });

  app.get("/api/attachments/:id", async (c) => {
    const attachment = getAttachment(db, c.req.param("id"));
    if (!attachment) return c.json({ error: "not found" }, 404);
    if (attachment.storage === "legacy") {
      return c.body(Buffer.from(attachment.data), 200, { "content-type": attachment.mime });
    }
    try {
      const data = await attachmentStore.read(attachment);
      return c.body(Buffer.from(data), 200, { "content-type": attachment.mime });
    } catch (error) {
      if (!(error instanceof AttachmentStorageError)) throw error;
      const status = error.code === "missing" ? 404 : error.code === "unsupported-media" ? 415 : 422;
      return c.json({ error: error.code }, status);
    }
  });

  return app;
}
