import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import {
  EvidenceCommandSchema,
  type EvidenceCommand,
  type ClassifyReferenceInput,
  type CreateProofContractInput,
  type CreateProofReportInput,
  type CreateReferenceRegistrationInput,
  type InspectEvidenceInput,
  type InspectionObservationInput,
  type OpenDesignEscalationInput,
  type RecordSourceSpecificationsInput,
  type RecordVisualVerificationBatchInput,
  type RecordVisualVerificationInput,
} from "@chamfer/shared";
import { Value } from "typebox/value";
import { conversationExists } from "../conversationStore";
import {
  appendEvidenceEvent,
  EvidenceIntegrityError,
  projectEvidence,
} from "../evidenceStore";
import type { ImageBlobStore } from "../attachmentStore";
import { listSourceSpecifications, recordSourceSpecifications } from "../sourceSpecifications";
import { listDesignEscalations, openDesignEscalation } from "../designEscalations";
import { classifyReference, listReferenceRecordsWithAvailability } from "../referenceClassification";
import { listReferenceRegistrations, registerReference } from "../referenceRegistrations";
import { listInspectionLeases, openInspectionLease, recordInspectionObservation } from "../inspectionLeases";
import {
  listVisualVerificationBatches,
  listVisualVerifications,
  recordVisualVerification,
  recordVisualVerificationBatch,
} from "../visualVerification";
import { createProofReport, listProofReports } from "../proofReports";
import { freezeProofContract } from "./proofContracts";

function isEvidenceCommand(value: unknown): value is EvidenceCommand {
  return Value.Check(EvidenceCommandSchema, value);
}

function compatibilityErrorStatus(error: Error): 400 | 404 | 409 | 422 {
  const code = (error as { code?: unknown }).code;
  if (code === "conflict") return 409;
  if (code === "not-found" || code === "missing") return 404;
  if (code === "corrupt") return 422;
  return 400;
}

function executeEvidenceCommand(
  db: DatabaseSync,
  conversationId: string,
  command: EvidenceCommand,
): unknown | Promise<unknown> {
  switch (command.type) {
    case "record-environment-verification":
      return appendEvidenceEvent(db, conversationId, command.event);
    case "record-plan":
      return appendEvidenceEvent(db, conversationId, command.event);
    case "record-verification-check-revision-attempt":
      return appendEvidenceEvent(db, conversationId, command.event);
    case "record-source-specifications": {
      return recordSourceSpecifications(
        db,
        conversationId,
        command.input,
        command.idempotencyKey,
      );
    }
    case "create-proof-report":
      return createProofReport(db, conversationId, command.input, command.idempotencyKey);
    case "open-design-escalation":
      return openDesignEscalation(db, conversationId, command.input, command.idempotencyKey);
    case "classify-reference":
      return classifyReference(db, conversationId, command.input, command.idempotencyKey);
    case "register-reference":
      return registerReference(db, conversationId, command.input, command.idempotencyKey);
    case "record-inspection-observation":
      return recordInspectionObservation(
        db,
        conversationId,
        command.leaseId,
        command.input,
        command.idempotencyKey,
      );
    case "record-visual-comparison":
      return appendEvidenceEvent(db, conversationId, {
        id: `${conversationId}:visual-comparison:${command.input.evidenceId}`,
        type: "visual-comparison.recorded",
        data: { comparison: command.input, commandIdempotencyKey: command.idempotencyKey },
      });
    case "record-visual-verification":
      return recordVisualVerification(db, conversationId, command.input, command.idempotencyKey);
    case "record-visual-verification-batch":
      return recordVisualVerificationBatch(db, conversationId, command.input, command.idempotencyKey);
    case "freeze-proof-contract":
      return freezeProofContract(db, conversationId, command.input);
    case "open-inspection-lease":
      throw new EvidenceIntegrityError("inspection store is required for this command");
  }
}

export function evidenceRoutes(db: DatabaseSync, attachmentStore: ImageBlobStore): Hono {
  const app = new Hono();

  // Compatibility resources remain stable for browser clients and integrations.
  // They are read and written through the same ledger-backed domain functions as
  // the unified command endpoint, so these routes do not restore legacy storage.
  app.get("/api/conversations/:id/references", async (c) => {
    const conversationId = c.req.param("id");
    if (!conversationExists(db, conversationId)) return c.json({ error: "not found" }, 404);
    return c.json(await listReferenceRecordsWithAvailability(db, attachmentStore, conversationId));
  });
  app.post("/api/conversations/:id/reference-classifications", async (c) => {
    const conversationId = c.req.param("id");
    if (!conversationExists(db, conversationId)) return c.json({ error: "not found" }, 404);
    try {
      return c.json(classifyReference(
        db,
        conversationId,
        await c.req.json<ClassifyReferenceInput>(),
        c.req.header("Idempotency-Key") || undefined,
      ));
    } catch (error) {
      if (error instanceof Error) return c.json({ error: error.message }, compatibilityErrorStatus(error));
      throw error;
    }
  });

  app.get("/api/conversations/:id/source-specifications", (c) => {
    const conversationId = c.req.param("id");
    if (!conversationExists(db, conversationId)) return c.json({ error: "not found" }, 404);
    return c.json(listSourceSpecifications(db, conversationId));
  });
  app.post("/api/conversations/:id/source-specifications", async (c) => {
    const conversationId = c.req.param("id");
    if (!conversationExists(db, conversationId)) return c.json({ error: "not found" }, 404);
    try {
      return c.json(recordSourceSpecifications(
        db,
        conversationId,
        await c.req.json<RecordSourceSpecificationsInput>(),
        c.req.header("Idempotency-Key") ?? "",
      ));
    } catch (error) {
      if (error instanceof Error) return c.json({ error: error.message }, compatibilityErrorStatus(error));
      throw error;
    }
  });

  app.get("/api/conversations/:id/proof-contracts", (c) => {
    const conversationId = c.req.param("id");
    if (!conversationExists(db, conversationId)) return c.json({ error: "not found" }, 404);
    return c.json(projectEvidence(db, conversationId).proofContracts);
  });
  app.post("/api/conversations/:id/proof-contracts", async (c) => {
    const conversationId = c.req.param("id");
    if (!conversationExists(db, conversationId)) return c.json({ error: "not found" }, 404);
    try {
      return c.json(freezeProofContract(db, conversationId, await c.req.json<CreateProofContractInput>()));
    } catch (error) {
      if (error instanceof Error) return c.json({ error: error.message }, compatibilityErrorStatus(error));
      throw error;
    }
  });

  app.get("/api/conversations/:id/proof-reports", (c) => {
    const conversationId = c.req.param("id");
    if (!conversationExists(db, conversationId)) return c.json({ error: "not found" }, 404);
    return c.json(listProofReports(db, conversationId));
  });
  app.post("/api/conversations/:id/proof-reports", async (c) => {
    const conversationId = c.req.param("id");
    if (!conversationExists(db, conversationId)) return c.json({ error: "not found" }, 404);
    try {
      return c.json(createProofReport(
        db,
        conversationId,
        await c.req.json<CreateProofReportInput>(),
        c.req.header("Idempotency-Key") ?? "",
      ));
    } catch (error) {
      if (error instanceof Error) return c.json({ error: error.message }, compatibilityErrorStatus(error));
      throw error;
    }
  });

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
      if (error instanceof Error) return c.json({ error: error.message }, compatibilityErrorStatus(error));
      throw error;
    }
  });

  app.get("/api/conversations/:id/reference-registrations", (c) => {
    const conversationId = c.req.param("id");
    if (!conversationExists(db, conversationId)) return c.json({ error: "not found" }, 404);
    return c.json(listReferenceRegistrations(db, conversationId));
  });
  app.post("/api/conversations/:id/reference-registrations", async (c) => {
    const conversationId = c.req.param("id");
    if (!conversationExists(db, conversationId)) return c.json({ error: "not found" }, 404);
    try {
      return c.json(registerReference(
        db,
        conversationId,
        await c.req.json<CreateReferenceRegistrationInput>(),
        c.req.header("Idempotency-Key") || undefined,
      ));
    } catch (error) {
      if (error instanceof Error) return c.json({ error: error.message }, compatibilityErrorStatus(error));
      throw error;
    }
  });

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
      return c.json(await openInspectionLease(
        db,
        attachmentStore,
        conversationId,
        await c.req.json<InspectEvidenceInput>(),
        c.req.header("Idempotency-Key") || undefined,
      ));
    } catch (error) {
      if (error instanceof Error) return c.json({ error: error.message }, compatibilityErrorStatus(error));
      throw error;
    }
  });
  app.post("/api/conversations/:id/inspection-leases/:leaseId/observations", async (c) => {
    const conversationId = c.req.param("id");
    if (!conversationExists(db, conversationId)) return c.json({ error: "not found" }, 404);
    try {
      return c.json(recordInspectionObservation(
        db,
        conversationId,
        c.req.param("leaseId"),
        await c.req.json<InspectionObservationInput>(),
        c.req.header("Idempotency-Key") || undefined,
      ));
    } catch (error) {
      if (error instanceof Error) return c.json({ error: error.message }, compatibilityErrorStatus(error));
      throw error;
    }
  });

  app.get("/api/conversations/:id/visual-verifications", (c) => {
    const conversationId = c.req.param("id");
    if (!conversationExists(db, conversationId)) return c.json({ error: "not found" }, 404);
    return c.json(listVisualVerifications(db, conversationId));
  });
  app.post("/api/conversations/:id/visual-verifications", async (c) => {
    const conversationId = c.req.param("id");
    if (!conversationExists(db, conversationId)) return c.json({ error: "not found" }, 404);
    try {
      return c.json(recordVisualVerification(
        db,
        conversationId,
        await c.req.json<RecordVisualVerificationInput>(),
        c.req.header("Idempotency-Key") || undefined,
      ));
    } catch (error) {
      if (error instanceof Error) return c.json({ error: error.message }, compatibilityErrorStatus(error));
      throw error;
    }
  });
  app.get("/api/conversations/:id/visual-verification-batches", (c) => {
    const conversationId = c.req.param("id");
    if (!conversationExists(db, conversationId)) return c.json({ error: "not found" }, 404);
    return c.json(listVisualVerificationBatches(db, conversationId));
  });
  app.post("/api/conversations/:id/visual-verification-batches", async (c) => {
    const conversationId = c.req.param("id");
    if (!conversationExists(db, conversationId)) return c.json({ error: "not found" }, 404);
    try {
      return c.json(recordVisualVerificationBatch(
        db,
        conversationId,
        await c.req.json<RecordVisualVerificationBatchInput>(),
        c.req.header("Idempotency-Key") || undefined,
      ));
    } catch (error) {
      if (error instanceof Error) return c.json({ error: error.message }, compatibilityErrorStatus(error));
      throw error;
    }
  });

  app.get("/api/conversations/:id/evidence", (c) => {
    const conversationId = c.req.param("id");
    if (!conversationExists(db, conversationId)) return c.json({ error: "not found" }, 404);
    return c.json(projectEvidence(db, conversationId));
  });

  app.post("/api/conversations/:id/evidence", async (c) => {
    const conversationId = c.req.param("id");
    if (!conversationExists(db, conversationId)) return c.json({ error: "not found" }, 404);
    const body = await c.req.json<unknown>().catch(() => undefined);
    try {
      if (!isEvidenceCommand(body)) {
        return c.json({ error: "a valid evidence command is required" }, 400);
      }
      if (body.type === "open-inspection-lease") {
        const lease = await openInspectionLease(
          db,
          attachmentStore,
          conversationId,
          body.input,
          body.idempotencyKey,
        );
        return c.json({ result: lease, projection: projectEvidence(db, conversationId) });
      }
      db.exec("BEGIN IMMEDIATE");
      const result = await executeEvidenceCommand(db, conversationId, body);
      db.exec("COMMIT");
      return c.json({ result, projection: projectEvidence(db, conversationId) });
    } catch (error) {
      if (db.isTransaction) {
        db.exec(error instanceof Error && (error as { commitEvidence?: unknown }).commitEvidence === true
          ? "COMMIT"
          : "ROLLBACK");
      }
      if (error instanceof Error) {
        const code = (error as { code?: unknown }).code;
        const status = code === "conflict" ? 409 : code === "missing" ? 404 : code === "corrupt" ? 422 : 400;
        return c.json({ error: error.message }, status);
      }
      throw error;
    }
  });

  return app;
}
