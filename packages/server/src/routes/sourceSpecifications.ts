import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import type { RecordSourceSpecificationsInput } from "@chamfer/shared";
import { conversationExists } from "../conversationStore";
import {
  listSourceSpecifications,
  recordSourceSpecifications,
  SourceSpecificationError,
} from "../sourceSpecifications";

export function sourceSpecificationRoutes(db: DatabaseSync): Hono {
  const app = new Hono();

  app.get("/api/conversations/:id/source-specifications", (c) => {
    const conversationId = c.req.param("id");
    if (!conversationExists(db, conversationId)) return c.json({ error: "not found" }, 404);
    return c.json(listSourceSpecifications(db, conversationId));
  });

  app.post("/api/conversations/:id/source-specifications", async (c) => {
    const conversationId = c.req.param("id");
    if (!conversationExists(db, conversationId)) return c.json({ error: "not found" }, 404);
    try {
      const input = await c.req.json<RecordSourceSpecificationsInput>();
      return c.json(recordSourceSpecifications(
        db,
        conversationId,
        input,
        c.req.header("Idempotency-Key") ?? "",
      ));
    } catch (error) {
      if (error instanceof SourceSpecificationError) {
        return c.json({ error: error.message }, error.code === "conflict" ? 409 : 400);
      }
      throw error;
    }
  });

  return app;
}
