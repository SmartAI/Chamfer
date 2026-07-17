import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import type { OpenDesignEscalationInput } from "@chamfer/shared";
import { conversationExists } from "../conversationStore";
import {
  DesignEscalationError,
  listDesignEscalations,
  openDesignEscalation,
} from "../designEscalations";

export function designEscalationRoutes(db: DatabaseSync): Hono {
  const app = new Hono();
  app.get("/api/conversations/:id/design-escalations", (c) => {
    const conversationId = c.req.param("id");
    if (!conversationExists(db, conversationId)) return c.json({ error: "not found" }, 404);
    return c.json(listDesignEscalations(db, conversationId));
  });
  app.post("/api/conversations/:id/design-escalations", async (c) => {
    const conversationId = c.req.param("id");
    if (!conversationExists(db, conversationId)) return c.json({ error: "not found" }, 404);
    try {
      return c.json(openDesignEscalation(
        db,
        conversationId,
        await c.req.json<OpenDesignEscalationInput>(),
        c.req.header("Idempotency-Key") ?? "",
      ));
    } catch (error) {
      if (error instanceof DesignEscalationError) {
        return c.json({ error: error.message }, error.code === "conflict" ? 409 : 400);
      }
      throw error;
    }
  });
  return app;
}
