import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import { isLlmProvider, type MessageDto } from "@chamfer/shared";
import { agentRoutes, type AgentSessionHost } from "../routes/agent";
import type { ArtifactStore } from "../agent/artifactStore";
import { conversationExists, createMessage, listMessages, maxMessageSeq } from "../conversationStore";
import { createDesign } from "../designStore";
import { withImmediateTransaction } from "../dbTransaction";
import { ConversationEventStore } from "../conversationEventStore";
import type { ContainerLlmDelivery } from "./config";

/**
 * The container's HTTP surface: the standard agent routes (same SSE event
 * contract as the local server) plus the stateless seams from ADR 0003 - the
 * container is never a store of record, so the caller seeds the stored
 * transcript before the first prompt of a boot and drains the turn's new rows
 * plus the artifact revision at turn end. Everything here runs against the
 * scratch conversation store under CHAMFER_DATA_DIR.
 */

/** One stored transcript row handed in by the outer store. id is optional and
 * preserved when present so row identity survives the round trip. */
export interface ContainerSeedRow {
  id?: string;
  seq: number;
  role: string;
  contentJson: string;
}

export interface ContainerSeedRequest {
  /** Only build123d is hosted; Fusion is local-only, permanently. */
  cadEnvironment?: "build123d";
  rows?: ContainerSeedRow[];
  /** Per-turn LLM routing: the model this turn runs, this conversation's
   * provider proxy base URL, and a token minted for exactly this turn.
   * Applied before the seed response returns, so the prompt that follows
   * never issues an LLM request on a stale model or stale credentials. */
  llm?: ContainerLlmDelivery;
}

export interface ContainerSeedResponse {
  ok: true;
  /** Rows actually written (rows at or below the stored watermark are skipped). */
  appended: number;
  /** Highest stored seq after seeding; -1 for an empty transcript. The caller
   * passes it back as afterSeq to drain exactly the turn's new rows. */
  maxSeq: number;
}

export interface ContainerTranscriptResponse {
  rows: MessageDto[];
  artifactRevision: number | null;
}

/** Mirrors createConversation but adopts the caller's conversation id: the
 * outer store owns conversation identity, and every stored row the container
 * hands back must carry it. */
function ensureConversation(db: DatabaseSync, conversationId: string): void {
  if (conversationExists(db, conversationId)) return;
  withImmediateTransaction(db, () => {
    const design = createDesign(db, "Hosted design", "build123d");
    new ConversationEventStore(db).append(conversationId, {
      recordedAt: Date.now(),
      type: "conversation.created",
      data: {
        title: "Hosted conversation",
        cadEnvironment: "build123d",
        designId: design.id,
        sourceSpecificationsRequired: true,
      },
    });
  });
}

function parseSeedRows(input: unknown): ContainerSeedRow[] {
  if (input === undefined) return [];
  if (!Array.isArray(input)) throw new Error("rows must be an array");
  let previousSeq = -1;
  return input.map((candidate) => {
    const row = candidate as { id?: unknown; seq?: unknown; role?: unknown; contentJson?: unknown };
    if (!Number.isInteger(row.seq) || (row.seq as number) < 0) throw new Error("row seq must be a non-negative integer");
    if ((row.seq as number) <= previousSeq) throw new Error("row seqs must be strictly increasing");
    previousSeq = row.seq as number;
    if (typeof row.role !== "string" || row.role.length === 0) throw new Error("row role is required");
    if (row.id !== undefined && typeof row.id !== "string") throw new Error("row id must be a string");
    if (typeof row.contentJson !== "string") throw new Error("row contentJson must be a string");
    // The same shape gate seedSessionFromStore applies, moved to the boundary:
    // a malformed row rejected here keeps the scratch store fully replayable.
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.contentJson);
    } catch {
      throw new Error(`row ${row.seq} contentJson is not valid JSON`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`row ${row.seq} contentJson is not a message object`);
    }
    return {
      ...(row.id !== undefined ? { id: row.id } : {}),
      seq: row.seq as number,
      role: row.role,
      contentJson: row.contentJson,
    };
  });
}

function parseLlmDelivery(input: unknown): ContainerLlmDelivery | undefined {
  if (input === undefined) return undefined;
  const llm = input as { baseUrl?: unknown; token?: unknown; modelJson?: unknown; provider?: unknown };
  if (typeof llm !== "object" || llm === null) throw new Error("llm must be an object");
  if (typeof llm.baseUrl !== "string" || llm.baseUrl.length === 0) throw new Error("llm.baseUrl is required");
  if (typeof llm.token !== "string" || llm.token.length === 0) throw new Error("llm.token is required");
  if (llm.provider !== undefined && !isLlmProvider(llm.provider)) {
    throw new Error(`llm.provider ${String(llm.provider)} is not a routable provider`);
  }
  if (llm.modelJson !== undefined) {
    if (typeof llm.modelJson !== "string" || llm.modelJson.length === 0) {
      throw new Error("llm.modelJson must be a non-empty string");
    }
    let provider: unknown;
    try {
      provider = (JSON.parse(llm.modelJson) as { provider?: unknown }).provider;
    } catch {
      throw new Error("llm.modelJson is not valid JSON");
    }
    if (!isLlmProvider(provider)) {
      throw new Error(`llm.modelJson names unroutable provider ${String(provider)}`);
    }
    if (llm.provider !== undefined && provider !== llm.provider) {
      throw new Error("llm.modelJson's provider does not match llm.provider");
    }
  }
  return {
    baseUrl: llm.baseUrl,
    token: llm.token,
    ...(llm.modelJson !== undefined ? { modelJson: llm.modelJson as string } : {}),
    ...(llm.provider !== undefined ? { provider: llm.provider } : {}),
  };
}

export interface ContainerAppOptions {
  /** Applies one turn's LLM routing (settings write + live-runtime credential
   * refresh); the entry wires it, tests may omit it. Runs inside the seed
   * handler so its failure fails the seed - a prompt must never start a turn
   * on stale credentials. */
  applyLlmDelivery?: (delivery: ContainerLlmDelivery) => Promise<void>;
}

export function createContainerApp(
  db: DatabaseSync,
  sessions: AgentSessionHost,
  artifacts: ArtifactStore,
  options: ContainerAppOptions = {},
): Hono {
  const app = new Hono();

  // Conversations whose pi session went live in this process: their in-memory
  // session is the live copy of the transcript, so rows seeded after that
  // point would never reach the model (seedSessionFromStore runs once, at
  // session build). Re-seeding rows the store already holds stays a no-op.
  const prompted = new Set<string>();
  const host: AgentSessionHost = {
    prompt: async (conversationId, text, images) => {
      await sessions.prompt(conversationId, text, images);
      prompted.add(conversationId);
    },
    abort: (conversationId) => sessions.abort(conversationId),
    subscribe: (conversationId, listener) => sessions.subscribe(conversationId, listener),
    status: (conversationId) => sessions.status(conversationId),
  };

  app.get("/api/health", (c) => c.json({ ok: true }));

  app.post("/api/container/:conversationId/seed", async (c) => {
    const conversationId = c.req.param("conversationId");
    const body = await c.req.json<ContainerSeedRequest>().catch(() => undefined);
    if (!body || typeof body !== "object") return c.json({ error: "a JSON body is required" }, 400);
    const environment = body.cadEnvironment ?? "build123d";
    if (environment !== "build123d") {
      return c.json({ error: "only the build123d environment is hosted; Fusion is local-only" }, 400);
    }
    let rows: ContainerSeedRow[];
    let llm: ContainerLlmDelivery | undefined;
    try {
      rows = parseSeedRows(body.rows);
      llm = parseLlmDelivery(body.llm);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
    if (llm && !options.applyLlmDelivery) {
      return c.json({ error: "this container has no LLM delivery seam configured" }, 500);
    }

    ensureConversation(db, conversationId);
    const watermark = maxMessageSeq(db, conversationId);
    const newRows = rows.filter((row) => row.seq > watermark);
    if (newRows.length > 0 && prompted.has(conversationId)) {
      return c.json({ error: "the conversation's session is already live in this container; new rows cannot be seeded" }, 409);
    }
    for (const row of newRows) {
      createMessage(db, conversationId, {
        id: row.id ?? crypto.randomUUID(),
        seq: row.seq,
        role: row.role,
        contentJson: row.contentJson,
      });
    }
    if (llm && options.applyLlmDelivery) {
      try {
        await options.applyLlmDelivery(llm);
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
      }
    }
    const response: ContainerSeedResponse = {
      ok: true,
      appended: newRows.length,
      maxSeq: Math.max(watermark, newRows.at(-1)?.seq ?? -1),
    };
    return c.json(response);
  });

  // Cheap run-state probe for the outer store's drain safety net (the user
  // DO's alarm): answers for any conversation id - an unknown one (e.g. after
  // this container restarted fresh) is simply not running.
  app.get("/api/container/:conversationId/status", (c) =>
    c.json(host.status(c.req.param("conversationId"))),
  );

  app.get("/api/container/:conversationId/transcript", async (c) => {
    const conversationId = c.req.param("conversationId");
    if (!conversationExists(db, conversationId)) return c.json({ error: "not found" }, 404);
    const afterSeqRaw = c.req.query("afterSeq") ?? "-1";
    const afterSeq = Number(afterSeqRaw);
    if (!Number.isInteger(afterSeq)) return c.json({ error: "afterSeq must be an integer" }, 400);
    const rows = listMessages(db, conversationId).filter((row) => row.seq > afterSeq);
    const artifact = await artifacts.current(conversationId);
    const response: ContainerTranscriptResponse = { rows, artifactRevision: artifact?.revision ?? null };
    return c.json(response);
  });

  app.route("/", agentRoutes(db, host, artifacts));
  return app;
}
