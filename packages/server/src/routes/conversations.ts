import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import { DEFAULT_CONVERSATION_TITLE, type GenerateTitleDto } from "@chamfer/shared";
import {
  conversationExists,
  createAttachment,
  createConversation,
  createMessage,
  deleteConversation,
  getAttachment,
  getConversation,
  listConversations,
  listAttachments,
  listMessages,
  messageExists,
  setConversationTitle,
} from "../conversationStore";
import { readEffectiveSettings } from "../settingsStore";
import { resolveProviderConfig } from "../providerConfig";
import { buildTitleTranscript, generateTitleText } from "../titles";
import type { LlmStreamer } from "../llm";

const VALID_ATTACHMENT_KINDS = new Set(["user-image", "view-sheet"]);

const SQLITE_CONSTRAINT_UNIQUE = 2067;

function isUniqueConstraintError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const errcode = (err as { errcode?: number }).errcode;
  if (errcode === SQLITE_CONSTRAINT_UNIQUE) return true;
  return err.message.includes("UNIQUE constraint failed");
}

export function conversationsRoutes(db: DatabaseSync, llm: LlmStreamer): Hono {
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
    const deleted = deleteConversation(db, c.req.param("id"));
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

  app.get("/api/conversations/:id/messages", (c) => {
    return c.json(listMessages(db, c.req.param("id")));
  });

  app.post("/api/messages/:id/attachments", async (c) => {
    const messageId = c.req.param("id");
    if (!messageExists(db, messageId)) return c.json({ error: "not found" }, 404);
    const kind = c.req.query("kind") ?? "";
    if (!VALID_ATTACHMENT_KINDS.has(kind)) return c.json({ error: "invalid kind" }, 400);
    const mime = c.req.query("mime") ?? "";
    const buffer = await c.req.arrayBuffer();
    const attachment = createAttachment(db, messageId, kind, mime, Buffer.from(buffer));
    return c.json(attachment);
  });

  app.get("/api/messages/:id/attachments", (c) => {
    const messageId = c.req.param("id");
    if (!messageExists(db, messageId)) return c.json({ error: "not found" }, 404);
    return c.json(listAttachments(db, messageId));
  });

  app.get("/api/attachments/:id", (c) => {
    const attachment = getAttachment(db, c.req.param("id"));
    if (!attachment) return c.json({ error: "not found" }, 404);
    return c.body(Buffer.from(attachment.data), 200, { "content-type": attachment.mime });
  });

  return app;
}
