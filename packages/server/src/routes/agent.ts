import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { DatabaseSync } from "node:sqlite";
import { conversationExists } from "../conversationStore";
// From agentStatus, not piSession: this route module also compiles into the
// Workers-typed online package, which must not pull the session host's
// Node-only import graph.
import type { AgentRunStatus, AgentServerEvent } from "../agent/agentStatus";
import type { ArtifactStore } from "../agent/artifactStore";

/** The slice of PiAgentSessions the routes need; a seam so route behavior
 * (status snapshot on connect, SSE framing) is testable without a live pi
 * session or MCP server. */
export interface AgentSessionHost {
  prompt(conversationId: string, text: string, images?: Array<{ data: string; mimeType: string }>): Promise<void>;
  abort(conversationId: string): Promise<void>;
  subscribe(conversationId: string, listener: (event: AgentServerEvent) => void): () => void;
  status(conversationId: string): AgentRunStatus;
}

/** Routes for the server-hosted pi agent: enqueue a prompt, stream session
 * events over SSE, and fetch the latest exported mesh artifact from the
 * artifact store. */
export function agentRoutes(db: DatabaseSync, sessions: AgentSessionHost, artifacts: ArtifactStore): Hono {
  const app = new Hono();

  app.post("/api/agent/:conversationId/messages", async (c) => {
    const conversationId = c.req.param("conversationId");
    if (!conversationExists(db, conversationId)) return c.json({ error: "not found" }, 404);
    const body = await c.req.json<{ text?: unknown; images?: unknown }>().catch(() => undefined);
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    if (!text) return c.json({ error: "text is required" }, 400);
    const images = Array.isArray(body?.images)
      ? body.images.filter((image): image is { data: string; mimeType: string } =>
          typeof image === "object" && image !== null &&
          typeof (image as { data?: unknown }).data === "string" &&
          typeof (image as { mimeType?: unknown }).mimeType === "string")
      : [];
    try {
      await sessions.prompt(conversationId, text, images);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 502);
    }
    return c.json({ ok: true }, 202);
  });

  app.post("/api/agent/:conversationId/abort", async (c) => {
    const conversationId = c.req.param("conversationId");
    if (!conversationExists(db, conversationId)) return c.json({ error: "not found" }, 404);
    await sessions.abort(conversationId);
    return c.json({ ok: true });
  });

  app.get("/api/agent/:conversationId/events", (c) => {
    const conversationId = c.req.param("conversationId");
    if (!conversationExists(db, conversationId)) return c.json({ error: "not found" }, 404);
    return streamSSE(c, async (stream) => {
      // Every (re)connect starts with a synthetic status snapshot so clients
      // never have to infer run state from stream silence: a Fusion execute
      // can run for minutes without a single interim event.
      await stream.writeSSE({
        id: "status",
        data: JSON.stringify({ type: "agent_status", ...sessions.status(conversationId) }),
      });
      await new Promise<void>((resolve) => {
        let sequence = 0;
        const unsubscribe = sessions.subscribe(conversationId, (event) => {
          void stream.writeSSE({
            id: String(sequence++),
            data: JSON.stringify(event),
          });
        });
        // Keepalive pings defeat idle proxy/browser timeouts during
        // multi-minute tool executions that emit no events.
        const keepalive = setInterval(() => {
          void stream.writeSSE({ event: "keepalive", data: "{}" });
        }, 15_000);
        stream.onAbort(() => {
          clearInterval(keepalive);
          unsubscribe();
          resolve();
        });
      });
    });
  });

  app.get("/api/agent/:conversationId/artifact", async (c) => {
    const conversationId = c.req.param("conversationId");
    if (!conversationExists(db, conversationId)) return c.json({ error: "not found" }, 404);
    const artifact = await artifacts.current(conversationId);
    if (!artifact) return c.json({ error: "no artifact" }, 404);
    const etag = `"artifact-r${artifact.revision}"`;
    if (c.req.header("if-none-match") === etag) return c.body(null, 304);
    let data: Uint8Array;
    try {
      data = await artifact.bytes();
    } catch {
      return c.json({ error: "artifact file missing" }, 404);
    }
    c.header("Content-Type", "model/stl");
    c.header("ETag", etag);
    c.header("X-Artifact-Revision", String(artifact.revision));
    return c.body(new Uint8Array(data));
  });

  return app;
}
