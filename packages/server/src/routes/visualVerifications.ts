import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import type { RecordVisualVerificationBatchInput, RecordVisualVerificationInput } from "@chamfer/shared";
import { conversationExists } from "../conversationStore";
import { listVisualVerificationBatches, listVisualVerifications, recordVisualVerification, recordVisualVerificationBatch, VisualVerificationError } from "../visualVerification";

export function visualVerificationRoutes(db: DatabaseSync): Hono {
  const app = new Hono();
  app.get("/api/conversations/:id/visual-verifications", (c) => {
    const conversationId = c.req.param("id");
    if (!conversationExists(db, conversationId)) return c.json({ error: "not found" }, 404);
    return c.json(listVisualVerifications(db, conversationId));
  });
  app.post("/api/conversations/:id/visual-verifications", async (c) => {
    const conversationId = c.req.param("id");
    if (!conversationExists(db, conversationId)) return c.json({ error: "not found" }, 404);
    try {
      return c.json(recordVisualVerification(db, conversationId, await c.req.json<RecordVisualVerificationInput>(), c.req.header("Idempotency-Key") || undefined));
    } catch (error) {
      if (error instanceof VisualVerificationError) return c.json({ error: error.message }, error.code === "conflict" ? 409 : 400);
      throw error;
    }
  });
  app.get("/api/conversations/:id/visual-verification-batches", (c) => {
    return c.json(listVisualVerificationBatches(db, c.req.param("id")));
  });
  app.post("/api/conversations/:id/visual-verification-batches", async (c) => {
    try {
      return c.json(recordVisualVerificationBatch(
        db,
        c.req.param("id"),
        await c.req.json<RecordVisualVerificationBatchInput>(),
        c.req.header("Idempotency-Key") || undefined,
      ));
    } catch (error) {
      if (error instanceof VisualVerificationError) return c.json({ error: error.message }, error.code === "conflict" ? 409 : 400);
      throw error;
    }
  });
  return app;
}
