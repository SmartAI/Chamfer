import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import { conversationExists } from "../conversationStore";
import { listDurableNotes } from "../durableNotes";

export function durableNoteRoutes(db: DatabaseSync): Hono {
  const app = new Hono();
  app.get("/api/conversations/:id/durable-notes", (c) => {
    const conversationId = c.req.param("id");
    if (!conversationExists(db, conversationId)) return c.json({ error: "not found" }, 404);
    return c.json(listDurableNotes(db, conversationId));
  });
  return app;
}
