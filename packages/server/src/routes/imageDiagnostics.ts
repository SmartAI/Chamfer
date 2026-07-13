import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import type { LlmStreamer } from "../llm";
import type { FakeLlmRequestDiagnostics } from "../fakeLlm";
import {
  verifyConversationImageDiagnostics,
  summarizeImageExposure,
} from "../imageContextDiagnostics";
import { conversationExists } from "../conversationStore";
import type { AttachmentStore } from "../attachmentStore";

function hasRequestDiagnostics(llm: LlmStreamer): llm is FakeLlmRequestDiagnostics {
  return "getRequestDiagnostics" in llm && typeof llm.getRequestDiagnostics === "function";
}

export function imageDiagnosticsRoutes(db: DatabaseSync, llm: LlmStreamer, store: AttachmentStore): Hono {
  const app = new Hono();
  app.get("/api/conversations/:id/image-diagnostics", async (c) => {
    const conversationId = c.req.param("id");
    if (!conversationExists(db, conversationId)) return c.json({ error: "not found" }, 404);
    return c.json(await verifyConversationImageDiagnostics(db, conversationId, store));
  });
  if (hasRequestDiagnostics(llm)) {
    app.get("/api/test/fake-model-requests", (c) => {
      const conversationId = c.req.query("conversationId") ?? "";
      if (!conversationExists(db, conversationId)) return c.json({ error: "not found" }, 404);
      const requests = llm.getRequestDiagnostics(conversationId);
      return c.json({ requests, exposure: summarizeImageExposure(requests) });
    });
  }
  return app;
}
