import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import type {
  CreateProofContractInput,
  ProofContractDerivationDto,
  ProofContractDto,
} from "@chamfer/shared";
import { REFERENCE_PROOF_POLICY, TEXT_PROOF_POLICY } from "@chamfer/shared";
import { conversationExists } from "../conversationStore";
import { listReferenceRegistrations } from "../referenceRegistrations";

interface ProofContractRow {
  contract_id: string;
  conversation_id: string;
  revision: number;
  plan_id: string;
  criteria_revision: number;
  registration_key: string;
  payload_json: string;
  frozen_at: number;
}

function rows(db: DatabaseSync, conversationId: string): ProofContractRow[] {
  return db.prepare(
    "SELECT * FROM proof_contracts WHERE conversation_id = ? ORDER BY rowid ASC",
  ).all(conversationId) as unknown as ProofContractRow[];
}

function toDtos(db: DatabaseSync, conversationId: string, records: ProofContractRow[]): ProofContractDto[] {
  const currentRegistrations = new Map(listReferenceRegistrations(db, conversationId)
    .filter((registration) => registration.status === "current")
    .map((registration) => [registration.registrationId, registration]));
  return records.map((row, index) => {
    const derivation = JSON.parse(row.payload_json) as ProofContractDerivationDto;
    const registrationsCurrent = derivation.shapeProof.status === "not-applicable" ||
      derivation.shapeProof.registrations.every((binding) =>
        currentRegistrations.get(binding.registrationId)?.revision === binding.revision);
    const current = index === records.length - 1 && registrationsCurrent;
    return {
      contractId: row.contract_id,
      conversationId: row.conversation_id,
      revision: row.revision,
      status: current ? "current" : "stale",
      proofStatus: current ? "pending" : "stale",
      frozenAt: row.frozen_at,
      derivation,
    };
  });
}

function validDerivation(value: unknown): value is ProofContractDerivationDto {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ProofContractDerivationDto>;
  return typeof candidate.planId === "string" && candidate.planId.length > 0 &&
    Number.isInteger(candidate.planRevision) && (candidate.planRevision ?? 0) > 0 &&
    Number.isInteger(candidate.criteriaRevision) && (candidate.criteriaRevision ?? 0) > 0 &&
    Array.isArray(candidate.sourceSpecificationIds) && candidate.sourceSpecificationIds.length > 0 &&
    typeof candidate.component?.id === "string" && candidate.component.id.length > 0 &&
    typeof candidate.component?.description === "string" && candidate.component.description.length > 0 &&
    Array.isArray(candidate.criteria) &&
    Array.isArray(candidate.plannedChecks) &&
    Array.isArray(candidate.unavailableEvidence) &&
    Array.isArray(candidate.invalidatedEvidenceIds) &&
    ((candidate.proofPolicy?.id === TEXT_PROOF_POLICY.id &&
      candidate.proofPolicy?.version === TEXT_PROOF_POLICY.version &&
      candidate.shapeProof?.status === "not-applicable") ||
     (candidate.proofPolicy?.id === REFERENCE_PROOF_POLICY.id &&
      candidate.proofPolicy?.version === REFERENCE_PROOF_POLICY.version &&
      (candidate.shapeProof?.status === "required" || candidate.shapeProof?.status === "unavailable") &&
      Array.isArray(candidate.shapeProof.registrations) && candidate.shapeProof.registrations.length > 0)) &&
    typeof candidate.shapeProof?.reason === "string" && candidate.shapeProof.reason.length > 0;
}

function registrationKey(derivation: ProofContractDerivationDto): string {
  if (derivation.shapeProof.status === "not-applicable") return "";
  return derivation.shapeProof.registrations
    .map((registration) => `${registration.registrationId}@${registration.revision}`)
    .sort()
    .join("|");
}

function registrationsAreCurrent(
  db: DatabaseSync,
  conversationId: string,
  derivation: ProofContractDerivationDto,
): boolean {
  if (derivation.shapeProof.status === "not-applicable") return true;
  const current = new Map(listReferenceRegistrations(db, conversationId)
    .filter((registration) => registration.status === "current")
    .map((registration) => [registration.registrationId, registration]));
  return derivation.shapeProof.registrations.every((binding) => {
    const registration = current.get(binding.registrationId);
    return registration?.referenceId === binding.referenceId &&
      registration.revision === binding.revision &&
      registration.eligibility.status === binding.eligibility;
  });
}

export function proofContractRoutes(db: DatabaseSync): Hono {
  const app = new Hono();

  app.get("/api/conversations/:id/proof-contracts", (c) => {
    const conversationId = c.req.param("id");
    if (!conversationExists(db, conversationId)) return c.json({ error: "not found" }, 404);
    return c.json(toDtos(db, conversationId, rows(db, conversationId)));
  });

  app.post("/api/conversations/:id/proof-contracts", async (c) => {
    const conversationId = c.req.param("id");
    if (!conversationExists(db, conversationId)) return c.json({ error: "not found" }, 404);
    const input = await c.req.json<CreateProofContractInput>().catch(() => undefined);
    if (!input || !validDerivation(input.derivation)) {
      return c.json({ error: "a valid proof-contract derivation is required" }, 400);
    }
    if (!registrationsAreCurrent(db, conversationId, input.derivation)) {
      return c.json({ error: "proof-contract reference registrations must be current and conversation-owned" }, 400);
    }
    const payloadJson = JSON.stringify(input.derivation);
    const bindingKey = registrationKey(input.derivation);
    const existing = db.prepare(
      "SELECT * FROM proof_contracts WHERE conversation_id = ? AND plan_id = ? AND criteria_revision = ? AND registration_key = ?",
    ).get(conversationId, input.derivation.planId, input.derivation.criteriaRevision, bindingKey) as unknown as ProofContractRow | undefined;
    if (existing) {
      if (existing.payload_json !== payloadJson) {
        return c.json({ error: "the proof contract for this criteria revision is already frozen with different derivation" }, 409);
      }
      const existingDto = toDtos(db, conversationId, rows(db, conversationId)).find((contract) =>
        contract.contractId === existing.contract_id && contract.revision === existing.revision,
      )!;
      return c.json(existingDto);
    }

    const priorForPlan = db.prepare(
      "SELECT * FROM proof_contracts WHERE conversation_id = ? AND plan_id = ? ORDER BY revision DESC LIMIT 1",
    ).get(conversationId, input.derivation.planId) as unknown as ProofContractRow | undefined;
    if (priorForPlan && input.derivation.criteriaRevision < priorForPlan.criteria_revision) {
      return c.json({ error: "proof-contract criteria revisions must advance monotonically" }, 409);
    }
    const contractId = priorForPlan?.contract_id ?? crypto.randomUUID();
    const revision = (priorForPlan?.revision ?? 0) + 1;
    const frozenAt = Date.now();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(`INSERT INTO proof_contracts
        (contract_id, conversation_id, revision, plan_id, criteria_revision, registration_key, payload_json, frozen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          contractId,
          conversationId,
          revision,
          input.derivation.planId,
          input.derivation.criteriaRevision,
          bindingKey,
          payloadJson,
          frozenAt,
        );
      db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(frozenAt, conversationId);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    const created = toDtos(db, conversationId, rows(db, conversationId)).find((contract) =>
      contract.contractId === contractId && contract.revision === revision,
    )!;
    return c.json(created);
  });

  return app;
}
