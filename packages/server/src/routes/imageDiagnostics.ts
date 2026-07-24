import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import { verifyConversationImageDiagnostics } from "../imageContextDiagnostics";
import { conversationExists } from "../conversationStore";
import type { ImageBlobStore } from "../imageBlobStore";

export function imageDiagnosticsRoutes(db: DatabaseSync, store: ImageBlobStore): Hono {
  const app = new Hono();
  app.get("/api/conversations/:id/image-diagnostics", async (c) => {
    const conversationId = c.req.param("id");
    if (!conversationExists(db, conversationId)) return c.json({ error: "not found" }, 404);
    return c.json(await verifyConversationImageDiagnostics(db, conversationId, store));
  });
  return app;
}
