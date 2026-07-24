import type { DatabaseSync } from "node:sqlite";
import type {
  CreateProofContractInput,
  ProofContractDerivationDto,
  ProofContractDto,
} from "@chamfer/shared";
import { REFERENCE_PROOF_POLICY, TEXT_PROOF_POLICY } from "@chamfer/shared";
import {
  compareCheckSets,
  frozenCheckSetFromContract,
  verificationCheckRevisionGate,
} from "@chamfer/shared";
import { listLegacyReferenceRegistrations } from "../referenceRegistrations";
import { appendEvidenceEvent, projectEvidence } from "../evidenceStore";

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
  const currentRegistrations = new Map(listLegacyReferenceRegistrations(db, conversationId)
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
  const current = new Map(listLegacyReferenceRegistrations(db, conversationId)
    .filter((registration) => registration.status === "current")
    .map((registration) => [registration.registrationId, registration]));
  return derivation.shapeProof.registrations.every((binding) => {
    const registration = current.get(binding.registrationId);
    return registration?.referenceId === binding.referenceId &&
      registration.revision === binding.revision &&
      registration.eligibility.status === binding.eligibility;
  });
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  const leftSet = new Set(left);
  return leftSet.size === right.length && right.every((id) => leftSet.has(id));
}

/**
 * A source correction replaces the frozen target instead of relaxing it.
 * Only an exact active source set reached through explicit supersession may
 * establish the replacement check baseline.
 */
function authoritativeSourceRevision(
  projection: ReturnType<typeof projectEvidence>,
  prior: ProofContractDto | undefined,
  nextIds: readonly string[],
): string[] | undefined {
  if (!prior || sameIds(prior.derivation.sourceSpecificationIds, nextIds)) return undefined;
  const activeIds = projection.sourceSpecifications
    .filter((specification) => specification.status === "active")
    .map((specification) => specification.id);
  if (!sameIds(activeIds, nextIds)) return undefined;
  const nextSet = new Set(nextIds);
  const removed = prior.derivation.sourceSpecificationIds.filter((id) => !nextSet.has(id));
  // A partial replacement cannot prove which planned checks belong only to the
  // corrected source. Keep the frozen baseline unless every prior source is
  // explicitly superseded, so an unchanged requirement cannot be relaxed as a
  // side effect of correcting a different one.
  if (removed.length !== prior.derivation.sourceSpecificationIds.length || removed.some((id) => {
    const specification = projection.sourceSpecifications.find((candidate) => candidate.id === id);
    return specification?.status !== "superseded" ||
      !specification.supersededBySpecificationId ||
      !nextSet.has(specification.supersededBySpecificationId);
  })) return undefined;
  return [...nextIds];
}

export class ProofContractError extends Error {
  constructor(
    message: string,
    public readonly code: "invalid" | "conflict" = "invalid",
    public readonly commitEvidence = false,
  ) {
    super(message);
  }
}

export function listLegacyProofContracts(db: DatabaseSync, conversationId: string): ProofContractDto[] {
  return toDtos(db, conversationId, rows(db, conversationId));
}

export function freezeProofContract(
  db: DatabaseSync,
  conversationId: string,
  input: CreateProofContractInput,
): ProofContractDto {
  if (!validDerivation(input.derivation)) {
    throw new ProofContractError("a valid proof-contract derivation is required");
  }
  const projection = projectEvidence(db, conversationId);
  const currentRegistrations = new Map(projection.referenceRegistrations
    .filter((registration) => registration.status === "current")
    .map((registration) => [registration.registrationId, registration]));
  const registrationsCurrent = input.derivation.shapeProof.status === "not-applicable" ||
    input.derivation.shapeProof.registrations.every((binding) => {
      const registration = currentRegistrations.get(binding.registrationId);
      return registration?.referenceId === binding.referenceId &&
        registration.revision === binding.revision &&
        registration.eligibility.status === binding.eligibility;
    });
  if (!registrationsCurrent) {
    throw new ProofContractError("proof-contract reference registrations must be current and conversation-owned");
  }
  const payloadJson = JSON.stringify(input.derivation);
  const bindingKey = registrationKey(input.derivation);
  const existing = projection.proofContracts.find((contract) =>
    contract.derivation.planId === input.derivation.planId &&
    contract.derivation.criteriaRevision === input.derivation.criteriaRevision &&
    registrationKey(contract.derivation) === bindingKey);
  if (existing) {
    if (JSON.stringify(existing.derivation) !== payloadJson) {
      throw new ProofContractError("the proof contract for this criteria revision is already frozen with different derivation", "conflict");
    }
    return existing;
  }
  const priorForPlan = projection.proofContracts
    .filter((contract) => contract.derivation.planId === input.derivation.planId)
    .sort((left, right) => right.revision - left.revision)[0];
  if (priorForPlan && input.derivation.criteriaRevision < priorForPlan.derivation.criteriaRevision) {
    throw new ProofContractError("proof-contract criteria revisions must advance monotonically", "conflict");
  }
  const authorization = input.relaxationEscalationId
    ? projection.designEscalations.find((escalation) =>
      escalation.escalationId === input.relaxationEscalationId &&
      escalation.kind === "verification-check-relaxation" &&
      escalation.status === "resolved")
    : undefined;
  if (input.relaxationEscalationId && !authorization) {
    throw new ProofContractError("check relaxation requires the named resolved verification-check-relaxation escalation", "conflict");
  }
  const sourceRevisionIds = authoritativeSourceRevision(
    projection,
    priorForPlan,
    input.derivation.sourceSpecificationIds,
  );
  const beforeChecks = priorForPlan && !sourceRevisionIds
    ? frozenCheckSetFromContract(priorForPlan).checks
    : [];
  const afterChecks = frozenCheckSetFromContract({
    contractId: priorForPlan?.contractId ?? "proposed",
    revision: (priorForPlan?.revision ?? 0) + 1,
    derivation: input.derivation,
  }).checks;
  if (authorization) {
    const heldAttempt = projection.verificationCheckRevisionAttempts.find((attempt) =>
      attempt.attemptId === authorization.verificationCheckAttemptId &&
      attempt.status === "held" &&
      attempt.planId === input.derivation.planId);
    if (!heldAttempt || compareCheckSets(heldAttempt.proposedChecks, afterChecks).verdict === "loosen") {
      throw new ProofContractError(
        "the resolved check-relaxation escalation does not authorize this proposal",
        "conflict",
      );
    }
  }
  const comparison = compareCheckSets(beforeChecks, afterChecks);
  const revisionGate = verificationCheckRevisionGate(beforeChecks, afterChecks, authorization?.escalationId);
  const attemptId = crypto.randomUUID();
  appendEvidenceEvent(db, conversationId, {
    id: `${conversationId}:verification-check-revision:${attemptId}`,
    type: "verification-checks.revision-attempted",
    data: {
      attempt: {
        attemptId,
        planId: input.derivation.planId,
        ...(priorForPlan
          ? { priorContractId: priorForPlan.contractId, priorContractRevision: priorForPlan.revision }
          : {}),
        proposedCriteriaRevision: input.derivation.criteriaRevision,
        proposedChecks: afterChecks,
        comparison,
        status: revisionGate.passed ? "accepted" : "held",
        ...(!revisionGate.passed ? { reason: revisionGate.reason } : {}),
        ...(revisionGate.passed && revisionGate.verdict === "loosen"
          ? { authorizedByEscalationId: revisionGate.authorizedByEscalationId }
          : {}),
        ...(sourceRevisionIds
          ? { authorizedBySourceSpecificationIds: sourceRevisionIds }
          : {}),
        attemptedAt: Date.now(),
      },
    },
  });
  if (!revisionGate.passed) {
    throw new ProofContractError(
      `proof-contract checks would loosen the frozen contract: ${revisionGate.reason}`,
      "conflict",
      true,
    );
  }
  const contractId = priorForPlan?.contractId ?? crypto.randomUUID();
  const revision = (priorForPlan?.revision ?? 0) + 1;
  const frozenAt = Date.now();
  const contract: ProofContractDto = {
    contractId,
    conversationId,
    revision,
    status: "current",
    proofStatus: "pending",
    frozenAt,
    derivation: input.derivation,
    checkRevision: {
      comparison,
      ...(revisionGate.verdict === "loosen"
        ? { authorizedByEscalationId: revisionGate.authorizedByEscalationId }
        : {}),
      ...(sourceRevisionIds
        ? { authorizedBySourceSpecificationIds: sourceRevisionIds }
        : {}),
    },
  };
  appendEvidenceEvent(db, conversationId, {
    id: `${conversationId}:proof-contract:${contract.contractId}:${contract.revision}`,
    type: "proof-contract.frozen",
    data: { contract },
  });
  return contract;
}
