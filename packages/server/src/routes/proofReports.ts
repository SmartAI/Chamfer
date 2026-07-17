import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import type { CreateProofReportInput } from "@chamfer/shared";
import { conversationExists } from "../conversationStore";
import { createProofReport, listProofReports, ProofReportError } from "../proofReports";

export function proofReportRoutes(db: DatabaseSync): Hono {
  const app = new Hono();

  app.get("/api/conversations/:id/proof-reports", (c) => {
    const conversationId = c.req.param("id");
    if (!conversationExists(db, conversationId)) return c.json({ error: "not found" }, 404);
    return c.json(listProofReports(db, conversationId));
  });

  app.post("/api/conversations/:id/proof-reports", async (c) => {
    const conversationId = c.req.param("id");
    if (!conversationExists(db, conversationId)) return c.json({ error: "not found" }, 404);
    try {
      const input = await c.req.json<CreateProofReportInput>();
      return c.json(createProofReport(db, conversationId, input, c.req.header("Idempotency-Key") ?? ""));
    } catch (error) {
      if (error instanceof ProofReportError) {
        return c.json({ error: error.message }, error.code === "conflict" ? 409 : 400);
      }
      throw error;
    }
  });

  return app;
}
