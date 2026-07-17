import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import type { AgentRunLifecycleBatch } from "@chamfer/shared";
import { conversationExists } from "../conversationStore";
import {
  AgentRunLifecycleError,
  getAgentRun,
  getLatestAgentRun,
  ingestAgentRunEvents,
} from "../agentRunLifecycle";

function errorStatus(error: AgentRunLifecycleError): 400 | 404 | 409 {
  if (error.code === "not-found") return 404;
  if (error.code === "conflict" || error.code === "ownership") return 409;
  return 400;
}

export interface AgentRunRouteOptions {
  release: string;
  onEvent?: Parameters<typeof ingestAgentRunEvents>[5];
}

export function agentRunRoutes(db: DatabaseSync, options: AgentRunRouteOptions): Hono {
  const app = new Hono();
  app.post("/api/conversations/:id/agent-runs/:runId/events", async (c) => {
    const contentLength = Number(c.req.header("content-length") ?? 0);
    if (contentLength > 64 * 1024) return c.json({ error: "lifecycle batch is too large" }, 413);
    const conversationId = c.req.param("id");
    if (!conversationExists(db, conversationId)) return c.json({ error: "not found" }, 404);
    const body = await c.req.json<AgentRunLifecycleBatch>().catch(() => undefined);
    if (!body || body.version !== 1 || !Array.isArray(body.events)) {
      return c.json({ error: "invalid lifecycle batch" }, 400);
    }
    try {
      return c.json(ingestAgentRunEvents(
        db,
        conversationId,
        c.req.param("runId"),
        body.events,
        options.release,
        options.onEvent,
      ));
    } catch (error) {
      if (error instanceof AgentRunLifecycleError) return c.json({ error: error.message }, errorStatus(error));
      throw error;
    }
  });
  app.get("/api/conversations/:id/agent-runs/latest", (c) => {
    const conversationId = c.req.param("id");
    if (!conversationExists(db, conversationId)) return c.json({ error: "not found" }, 404);
    const run = getLatestAgentRun(db, conversationId);
    return run ? c.json(run) : c.json({ error: "not found" }, 404);
  });
  app.get("/api/conversations/:id/agent-runs/:runId", (c) => {
    const conversationId = c.req.param("id");
    if (!conversationExists(db, conversationId)) return c.json({ error: "not found" }, 404);
    const run = getAgentRun(db, conversationId, c.req.param("runId"));
    return run ? c.json(run) : c.json({ error: "not found" }, 404);
  });
  return app;
}
