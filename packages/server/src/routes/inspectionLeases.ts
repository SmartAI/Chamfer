import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import type { InspectEvidenceInput, InspectionObservationInput } from "@chamfer/shared";
import type { AttachmentStore } from "../attachmentStore";
import { conversationExists } from "../conversationStore";
import {
  InspectionLeaseError,
  listInspectionLeases,
  openInspectionLease,
  recordInspectionObservation,
} from "../inspectionLeases";

function errorStatus(error: InspectionLeaseError): 400 | 404 | 409 | 422 {
  if (error.code === "conflict") return 409;
  if (error.code === "not-found" || error.code === "missing") return 404;
  if (error.code === "corrupt") return 422;
  return 400;
}

export function inspectionLeaseRoutes(db: DatabaseSync, store: AttachmentStore): Hono {
  const app = new Hono();
  app.get("/api/conversations/:id/inspection-leases", (c) => {
    const conversationId = c.req.param("id");
    if (!conversationExists(db, conversationId)) return c.json({ error: "not found" }, 404);
    const requested = c.req.query("status");
    const status = requested === "open" || requested === "closed" ? requested : undefined;
    return c.json(listInspectionLeases(db, conversationId, status));
  });
  app.post("/api/conversations/:id/inspection-leases", async (c) => {
    const conversationId = c.req.param("id");
    if (!conversationExists(db, conversationId)) return c.json({ error: "not found" }, 404);
    try {
      return c.json(await openInspectionLease(db, store, conversationId, await c.req.json<InspectEvidenceInput>(), c.req.header("Idempotency-Key") || undefined));
    } catch (error) {
      if (error instanceof InspectionLeaseError) return c.json({ error: error.message }, errorStatus(error));
      throw error;
    }
  });
  app.post("/api/conversations/:id/inspection-leases/:leaseId/observations", async (c) => {
    const conversationId = c.req.param("id");
    if (!conversationExists(db, conversationId)) return c.json({ error: "not found" }, 404);
    try {
      return c.json(recordInspectionObservation(db, conversationId, c.req.param("leaseId"), await c.req.json<InspectionObservationInput>(), c.req.header("Idempotency-Key") || undefined));
    } catch (error) {
      if (error instanceof InspectionLeaseError) return c.json({ error: error.message }, errorStatus(error));
      throw error;
    }
  });
  return app;
}
