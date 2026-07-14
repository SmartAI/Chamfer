import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import type { LlmStreamer } from "../llm";
import type { FakeLlmTestController } from "../fakeLlm";
import { conversationExists } from "../conversationStore";
import { summarizeImageExposure } from "../imageContextDiagnostics";

function hasFakeLlmTestControls(llm: LlmStreamer): llm is FakeLlmTestController {
  return "getRequestDiagnostics" in llm && typeof llm.getRequestDiagnostics === "function" &&
    "isRequestHeld" in llm && typeof llm.isRequestHeld === "function" &&
    "releaseHeldRequest" in llm && typeof llm.releaseHeldRequest === "function";
}

export function fakeLlmTestControlRoutes(db: DatabaseSync, llm: LlmStreamer): Hono {
  const app = new Hono();
  if (!hasFakeLlmTestControls(llm)) return app;

  app.get("/api/test/fake-model-requests", (c) => {
    const conversationId = c.req.query("conversationId") ?? "";
    if (!conversationExists(db, conversationId)) return c.json({ error: "not found" }, 404);
    const requests = llm.getRequestDiagnostics(conversationId);
    return c.json({ requests, exposure: summarizeImageExposure(requests) });
  });
  app.get("/api/test/fake-model-holds", (c) => {
    const conversationId = c.req.query("conversationId") ?? "";
    if (!conversationExists(db, conversationId)) return c.json({ error: "not found" }, 404);
    return c.json({ held: llm.isRequestHeld(conversationId) });
  });
  app.post("/api/test/fake-model-holds/release", (c) => {
    const conversationId = c.req.query("conversationId") ?? "";
    if (!conversationExists(db, conversationId)) return c.json({ error: "not found" }, 404);
    return c.json({ released: llm.releaseHeldRequest(conversationId) });
  });
  return app;
}
