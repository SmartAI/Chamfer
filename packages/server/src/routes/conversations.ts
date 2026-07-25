import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_CONVERSATION_TITLE,
  isCadCodeIdentity,
  isLlmProvider,
  isMeasurements,
  modelJsonProvider,
  resolveTurnFunding,
  type AttachmentReferenceBlock,
  type CadEnvironment,
  type ConversationDto,
  type GenerateTitleDto,
  type HeadlessRunDto,
  type ConversationEvent,
} from "@chamfer/shared";
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
import { AttachmentStorageError, type ImageBlobStore, type StoredImageBlob } from "../imageBlobStore";
import { readEffectiveSettings } from "../settingsStore";
import { resolveProviderConfig } from "../providerConfig";
import { buildTitleTranscript, generateTitleText } from "../titles";
import type { LlmStreamer } from "../llm";
import { deleteConversationWithAttachments } from "../conversationDeletion";
import { getDesign } from "../designStore";
import { ConversationEventStore } from "../conversationEventStore";
import { replayThenLive } from "../replayThenLive";

const VALID_ATTACHMENT_KINDS = new Set(["user-image", "view-sheet"]);
const VALID_CAD_ENVIRONMENTS = new Set<CadEnvironment>(["build123d", "fusion"]);

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
  if (message.role === "toolResult" &&
      (message.toolName === "run_build123d" || (message.toolName === "execute_cad_change" && isRecord(message.details) && isRecord(message.details.code)))) {
    if (viewSheets.length !== 1 || !isRecord(message.details) || !isRecord(message.details.inspectionSheet)) {
      return { error: "CAD image messages require one derived inspection sheet" };
    }
    if (!isCadCodeIdentity(message.details.code) || !isMeasurements(message.details.measurements)) {
      return { error: "CAD image messages require valid code identity and measurements" };
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
  } else if (message.role === "toolResult" &&
      (message.toolName === "inspect_fusion" ||
        (message.toolName === "execute_cad_change" && isRecord(message.details) && isRecord(message.details.inspection)))) {
    const visual = isRecord(message.details) && isRecord(message.details.visualArtifact) ? message.details.visualArtifact : undefined;
    const inspectionSheet = visual && isRecord(visual.inspectionSheet) ? visual.inspectionSheet : undefined;
    if (viewSheets.length !== 1 || inspectionSheet?.attachmentId !== viewSheets[0]!.attachmentId ||
        typeof visual?.artifactId !== "string" || typeof visual.artifactVersion !== "number" || typeof visual.revision !== "string") {
      return { error: "Fusion image messages require one revision-bound inspection sheet" };
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

export function conversationsRoutes(
  db: DatabaseSync,
  llm: LlmStreamer,
  attachmentStore: ImageBlobStore,
  options: {
    activeRun?: (conversationId: string) => HeadlessRunDto | undefined;
    stopActiveRun?: (runId: string) => Promise<void>;
    /** Whether this conversation has a current exported model. Overlaid onto the
     * DTO so the sidebar can mark a build123d conversation green once it has
     * produced a model - that flow emits no gate verdict, so `lastGateStatus`
     * would otherwise leave every successful conversation neutral. Backed by the
     * artifact store (the export file on disk), so it survives restarts. */
    hasArtifact?: (conversationId: string) => Promise<boolean>;
    /** Deployment default model backing server-initiated calls (title
     * generation) when the settings table names none - the online demo path. */
    defaultModelJson?: string;
  } = {},
): Hono {
  const { activeRun, stopActiveRun, hasArtifact } = options;
  const app = new Hono();
  const eventStore = new ConversationEventStore(db);

  /** Decorates a stored conversation with its transient run/artifact status. */
  async function withStatus(conversation: ConversationDto): Promise<ConversationDto> {
    const run = activeRun?.(conversation.id);
    const artifact = hasArtifact ? await hasArtifact(conversation.id) : false;
    return {
      ...conversation,
      ...(run ? { liveRun: run } : {}),
      ...(artifact ? { hasArtifact: true } : {}),
    };
  }

  app.post("/api/conversations", async (c) => {
    const body = (await c.req.json()) as {
      title?: unknown;
      cadEnvironment?: unknown;
      designId?: unknown;
      designName?: unknown;
    };
    if (typeof body.title !== "string" || body.title.trim().length === 0) {
      return c.json({ error: "title is required" }, 400);
    }
    if (typeof body.cadEnvironment !== "string" ||
        !VALID_CAD_ENVIRONMENTS.has(body.cadEnvironment as CadEnvironment)) {
      return c.json({ error: "cadEnvironment must be build123d or fusion" }, 400);
    }
    if (body.designId !== undefined && typeof body.designId !== "string") {
      return c.json({ error: "designId must be a string" }, 400);
    }
    if (body.designName !== undefined &&
        (typeof body.designName !== "string" || body.designName.trim().length === 0)) {
      return c.json({ error: "designName must be non-empty" }, 400);
    }
    if (typeof body.designId === "string") {
      const design = getDesign(db, body.designId);
      if (!design) return c.json({ error: "design not found" }, 404);
      if (design.cadEnvironment !== body.cadEnvironment) {
        return c.json({ error: "conversation CAD environment must match the design" }, 409);
      }
    }
    const conversation = createConversation(
      db,
      body.title,
      body.cadEnvironment as CadEnvironment,
      typeof body.designId === "string" ? body.designId : undefined,
      typeof body.designName === "string" ? body.designName.trim() : undefined,
    );
    return c.json(conversation);
  });

  app.get("/api/conversations", async (c) => {
    return c.json(await Promise.all(listConversations(db).map(withStatus)));
  });

  app.get("/api/conversations/:id", async (c) => {
    const conversation = getConversation(db, c.req.param("id"));
    return conversation ? c.json(await withStatus(conversation)) : c.json({ error: "not found" }, 404);
  });

  // This is the same subscribe-before-replay, buffer, deduplicate, then-live
  // discipline used by the headless run SSE route. Last-Event-ID and `after`
  // share the same suffix cursor so a browser reload resumes without a second
  // streaming protocol or a bespoke reconstruction path.
  app.get("/api/conversations/:id/events", (c) => {
    const conversationId = c.req.param("id");
    if (!conversationExists(db, conversationId)) return c.json({ error: "not found" }, 404);
    const requestedAfter = Number(c.req.header("last-event-id") ?? c.req.query("after") ?? 0);
    const after = Number.isFinite(requestedAfter) ? requestedAfter : 0;
    return streamSSE(c, async (stream) => {
      await new Promise<void>((resolve) => {
        const connection = replayThenLive<ConversationEvent>({
          after,
          sequence: (event) => event.sequence,
          replay: (cursor) => eventStore.events(conversationId, cursor),
          subscribe: (listener) => eventStore.subscribe(conversationId, listener),
          write: (event) => stream.writeSSE({
            id: String(event.sequence),
            event: event.type,
            data: JSON.stringify(event),
          }),
          onClose: resolve,
        });
        stream.onAbort(() => {
          void connection.close();
        });
      });
    });
  });

  app.get("/api/conversations/:id/conversation-state", (c) => {
    const conversationId = c.req.param("id");
    if (!conversationExists(db, conversationId)) return c.json({ error: "not found" }, 404);
    return c.json(eventStore.project(conversationId));
  });

  app.put("/api/conversations/:id/ui-state/:key", async (c) => {
    const conversationId = c.req.param("id");
    if (!conversationExists(db, conversationId)) return c.json({ error: "not found" }, 404);
    const key = c.req.param("key");
    if (key.length === 0 || key.length > 100) return c.json({ error: "invalid UI state key" }, 400);
    const body = await c.req.json<{ value?: unknown }>().catch(() => undefined);
    if (!body || !("value" in body)) return c.json({ error: "value is required" }, 400);
    const event = eventStore.append(conversationId, {
      type: "ui.state-updated",
      data: { key, value: body.value },
    });
    return c.json(event);
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
    // Same funding rule as hosted turns and the client's composer gate
    // (resolveTurnFunding in @chamfer/shared): a fresh account gets the
    // deployment default, and a selected model whose provider is unkeyed
    // falls back to it too when the deployment can fund the call - instead
    // of erroring "demo covers Anthropic only" while the agent turn quietly
    // succeeds on the same fallback (#53).
    const fallbackProvider = modelJsonProvider(options.defaultModelJson);
    const verdict = resolveTurnFunding({
      selectedProvider: modelJsonProvider(settings.modelJson),
      keys: settings,
      fallbackProvider: isLlmProvider(fallbackProvider) ? fallbackProvider : undefined,
    });
    const modelJson = verdict.kind === "run" && verdict.model === "fallback"
      ? options.defaultModelJson
      : settings.modelJson ?? options.defaultModelJson;
    if (!modelJson) return c.json({ error: "no model configured" }, 400);
    const transcript = buildTitleTranscript(listMessages(db, id));
    if (!transcript) {
      return c.json({ title: conversation.title, generated: false } satisfies GenerateTitleDto);
    }
    const model = JSON.parse(modelJson) as unknown;
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

  app.delete("/api/conversations/:id", async (c) => {
    const conversationId = c.req.param("id");
    const run = activeRun?.(conversationId);
    if (run && stopActiveRun) await stopActiveRun(run.id);
    const deleted = await deleteConversationWithAttachments(db, attachmentStore, conversationId);
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
    const cleanup = async () => {
      for (const blob of created.values()) {
        if (attachmentReferenceCount(db, blob.contentHash) !== 0) continue;
        try {
          await attachmentStore.remove(blob.blobPath);
        } catch {
          // Startup maintenance reclaims crash and cleanup-failure orphans.
        }
      }
    };
    try {
      for (const attachment of attachments) {
        const decoded = decodeBase64(attachment.data);
        if (!decoded) {
          await cleanup();
          return c.json({ error: "invalid base64 attachment data" }, 400);
        }
        const blob = await attachmentStore.write(decoded, attachment.mime);
        blobs.push(blob);
        if (blob.created) created.set(blob.blobPath, blob);
      }
    } catch (error) {
      await cleanup();
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
      await cleanup();
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
      await cleanup();
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
            await attachmentStore.remove(blob.blobPath);
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
