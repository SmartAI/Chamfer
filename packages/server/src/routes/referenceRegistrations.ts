import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import type { CreateReferenceRegistrationInput } from "@chamfer/shared";
import { conversationExists } from "../conversationStore";
import {
  listReferenceRegistrations,
  ReferenceRegistrationError,
  registerReference,
} from "../referenceRegistrations";

export function referenceRegistrationRoutes(db: DatabaseSync): Hono {
  const app = new Hono();

  app.get("/api/conversations/:id/reference-registrations", (c) => {
    const conversationId = c.req.param("id");
    if (!conversationExists(db, conversationId)) return c.json({ error: "not found" }, 404);
    return c.json(listReferenceRegistrations(db, conversationId));
  });

  app.post("/api/conversations/:id/reference-registrations", async (c) => {
    const conversationId = c.req.param("id");
    if (!conversationExists(db, conversationId)) return c.json({ error: "not found" }, 404);
    try {
      const input = await c.req.json<CreateReferenceRegistrationInput>();
      return c.json(registerReference(db, conversationId, input, c.req.header("Idempotency-Key") || undefined));
    } catch (error) {
      if (error instanceof ReferenceRegistrationError) {
        return c.json({ error: error.message }, error.code === "conflict" ? 409 : 400);
      }
      throw error;
    }
  });

  return app;
}
