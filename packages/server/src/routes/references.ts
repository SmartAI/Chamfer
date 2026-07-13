import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import type { ClassifyReferenceInput } from "@chamfer/shared";
import {
  classifyReference,
  listReferenceRecordsWithAvailability,
  ReferenceClassificationError,
} from "../referenceClassification";
import { conversationExists } from "../conversationStore";
import type { AttachmentStore } from "../attachmentStore";

export function referenceRoutes(db: DatabaseSync, attachmentStore: AttachmentStore): Hono {
  const app = new Hono();

  app.get("/api/conversations/:id/references", async (c) => {
    const conversationId = c.req.param("id");
    if (!conversationExists(db, conversationId)) return c.json({ error: "not found" }, 404);
    return c.json(await listReferenceRecordsWithAvailability(db, attachmentStore, conversationId));
  });

  app.post("/api/conversations/:id/reference-classifications", async (c) => {
    const conversationId = c.req.param("id");
    if (!conversationExists(db, conversationId)) return c.json({ error: "not found" }, 404);
    try {
      const input = await c.req.json<ClassifyReferenceInput>();
      return c.json(classifyReference(db, conversationId, input, c.req.header("Idempotency-Key") || undefined));
    } catch (error) {
      if (error instanceof ReferenceClassificationError) return c.json({ error: error.message }, error.code === "conflict" ? 409 : 400);
      throw error;
    }
  });

  return app;
}
