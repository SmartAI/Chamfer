import type { DatabaseSync } from "node:sqlite";
import type {
  CreateProofReportInput,
  Gate,
  Measurements,
  ProofContractDerivationDto,
  ProofContractDto,
  ProofEvidenceState,
  ProofReportDto,
  ReferenceRegistrationDto,
  ShapeProofRecord,
} from "@chamfer/shared";
import { SHAPE_PROOF_POLICY } from "@chamfer/shared";
import { listLegacyReferenceRecords, listReferenceRecords } from "./referenceClassification";
import { listLegacyReferenceRegistrations, listReferenceRegistrations } from "./referenceRegistrations";
import { listLegacySourceSpecifications, listSourceSpecifications } from "./sourceSpecifications";
import { listLegacyVisualVerifications, listVisualVerifications } from "./visualVerification";
import { appendEvidenceEvent, projectEvidence } from "./evidenceStore";

type ReportStatus = ProofReportDto["status"];

interface ProofReportRow {
  report_id: string;
  conversation_id: string;
  proof_contract_id: string;
  proof_contract_revision: number;
  plan_id: string;
  criteria_revision: number;
  artifact_id: string;
  artifact_version: number;
  payload_json: string;
  created_at: number;
}

interface ProofContractRow {
  contract_id: string;
  conversation_id: string;
  revision: number;
  payload_json: string;
  frozen_at: number;
}

interface ArtifactRow {
  id: string;
  conversation_id: string;
  version: number;
  created_at: number;
}

interface MessageRecord {
  role?: unknown;
  toolName?: unknown;
  toolCallId?: unknown;
  isError?: unknown;
  details?: {
    plan?: unknown;
    code?: { artifactId?: unknown; artifactVersion?: unknown };
    gate?: unknown;
    planConformance?: unknown;
    measurements?: unknown;
    shapeProof?: unknown;
    inspectionSheet?: { attachmentId?: unknown };
  };
}

interface DomainPlanRecord {
  goal: string;
  components: Array<{ id?: unknown; status?: unknown; retired_revision?: unknown }>;
  domain: {
    format: "domain-operations-v1";
    plan_id: string;
    revision: number;
    criteria_revision: number;
    source_specification_ids: string[];
  };
}

interface PlanConformanceRecord {
  status: "passed" | "failed";
  planId: string;
  componentCriteriaRevisions: Record<string, number>;
}

export class ProofReportError extends Error {
  constructor(message: string, readonly code: "invalid" | "conflict" = "invalid") {
    super(message);
  }
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
}

function messages(db: DatabaseSync, conversationId: string): MessageRecord[] {
  const rows = db.prepare(
    "SELECT content_json FROM messages WHERE conversation_id = ? ORDER BY seq ASC",
  ).all(conversationId) as Array<{ content_json: string }>;
  return rows.flatMap((row) => {
    try {
      return [JSON.parse(row.content_json) as MessageRecord];
    } catch {
      return [];
    }
  });
}

function isDomainPlan(value: unknown): value is DomainPlanRecord {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<DomainPlanRecord>;
  return typeof candidate.goal === "string" && Array.isArray(candidate.components) &&
    candidate.domain?.format === "domain-operations-v1" &&
    typeof candidate.domain.plan_id === "string" &&
    Number.isInteger(candidate.domain.revision) &&
    Number.isInteger(candidate.domain.criteria_revision) &&
    Array.isArray(candidate.domain.source_specification_ids);
}

function latestPlan(records: readonly MessageRecord[]): DomainPlanRecord | undefined {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record?.role !== "toolResult" || record.isError === true) continue;
    if (record.toolName !== "create_plan" && record.toolName !== "revise_plan") continue;
    if (isDomainPlan(record.details?.plan)) return record.details.plan;
  }
  return undefined;
}

function evidenceRecord(records: readonly MessageRecord[], evidenceId: string): MessageRecord | undefined {
  return records.find((record) =>
    record.role === "toolResult" && (record.toolName === "run_build123d" || record.toolName === "execute_cad_change") &&
      record.toolCallId === evidenceId,
  );
}

function latestArtifact(db: DatabaseSync, conversationId: string): ArtifactRow | undefined {
  return db.prepare(
    "SELECT id, conversation_id, version, created_at FROM artifacts WHERE conversation_id = ? ORDER BY version DESC LIMIT 1",
  ).get(conversationId) as unknown as ArtifactRow | undefined;
}

function exactContract(
  db: DatabaseSync,
  conversationId: string,
  contractId: string,
  revision: number,
): ProofContractRow | undefined {
  return db.prepare(
    "SELECT contract_id, conversation_id, revision, payload_json, frozen_at FROM proof_contracts WHERE conversation_id = ? AND contract_id = ? AND revision = ?",
  ).get(conversationId, contractId, revision) as unknown as ProofContractRow | undefined;
}

function latestContract(db: DatabaseSync, conversationId: string): ProofContractRow | undefined {
  return db.prepare(
    "SELECT contract_id, conversation_id, revision, payload_json, frozen_at FROM proof_contracts WHERE conversation_id = ? ORDER BY rowid DESC LIMIT 1",
  ).get(conversationId) as unknown as ProofContractRow | undefined;
}

function contractDto(row: ProofContractRow): ProofContractDto {
  return {
    contractId: row.contract_id,
    conversationId: row.conversation_id,
    revision: row.revision,
    status: "current",
    proofStatus: "pending",
    frozenAt: row.frozen_at,
    derivation: JSON.parse(row.payload_json) as ProofContractDerivationDto,
  };
}

function gateRecord(value: unknown): Gate | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const gate = value as Partial<Gate>;
  if (gate.status !== "passed" && gate.status !== "failed" && gate.status !== "error") return undefined;
  if (!Array.isArray(gate.checks)) return undefined;
  return gate as Gate;
}

function planConformanceRecord(value: unknown): PlanConformanceRecord | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Partial<PlanConformanceRecord>;
  if (record.status !== "passed" && record.status !== "failed") return undefined;
  if (typeof record.planId !== "string" || typeof record.componentCriteriaRevisions !== "object" || record.componentCriteriaRevisions === null) {
    return undefined;
  }
  return record as PlanConformanceRecord;
}

function measurementsRecord(value: unknown): Measurements | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const measurements = value as Partial<Measurements>;
  if (!Array.isArray(measurements.bboxMm) || typeof measurements.volumeMm3 !== "number" ||
    typeof measurements.areaMm2 !== "number" || !Array.isArray(measurements.children)) {
    return undefined;
  }
  return measurements as Measurements;
}

function shapeProofRecord(value: unknown): ShapeProofRecord | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Partial<ShapeProofRecord>;
  if (!Array.isArray(record.views) || !record.artifact || !record.contract || !record.coverage ||
      !record.policy || !record.evaluator ||
      (record.status !== "passed" && record.status !== "failed" && record.status !== "error")) {
    return undefined;
  }
  return record as ShapeProofRecord;
}

function currentReferenceRegistrations(
  db: DatabaseSync,
  conversationId: string,
  contract: ProofContractDto,
): ReferenceRegistrationDto[] {
  if (contract.derivation.shapeProof.status === "not-applicable") return [];
  const current = listReferenceRegistrations(db, conversationId)
    .filter((registration) => registration.status === "current");
  return contract.derivation.shapeProof.registrations.map((binding) => {
    const registration = current.find((candidate) =>
      candidate.registrationId === binding.registrationId &&
      candidate.referenceId === binding.referenceId &&
      candidate.revision === binding.revision &&
      candidate.eligibility.status === binding.eligibility,
    );
    if (!registration) {
      throw new ProofReportError(`reference registration ${binding.registrationId} revision ${binding.revision} is stale or unavailable`, "conflict");
    }
    return registration;
  });
}

function shapeProofIdentityErrors(
  record: ShapeProofRecord,
  input: CreateProofReportInput,
  contract: ProofContractDto,
  registrations: readonly ReferenceRegistrationDto[],
  activeReferenceIds: readonly string[],
): string[] {
  const errors: string[] = [];
  const expectedRegistrationIds = registrations.map((registration) => registration.registrationId).sort();
  const coveredRegistrationIds = record.coverage.requiredRegistrationIds.slice().sort();
  const coveredReferenceIds = record.coverage.activeReferenceIds.slice().sort();
  const expectedReferenceIds = [...activeReferenceIds].sort();
  if (record.artifact.id !== input.artifactId || record.artifact.version !== input.artifactVersion) {
    errors.push("shape proof targets a different CAD artifact");
  }
  if (record.contract.id !== contract.contractId || record.contract.revision !== contract.revision ||
      record.contract.criteriaRevision !== input.criteriaRevision) {
    errors.push("shape proof targets a different proof contract or criteria revision");
  }
  if (record.policy.id !== SHAPE_PROOF_POLICY.id || record.policy.version !== SHAPE_PROOF_POLICY.version ||
      record.evaluator.id !== SHAPE_PROOF_POLICY.evaluator.id ||
      record.evaluator.version !== SHAPE_PROOF_POLICY.evaluator.version) {
    errors.push("shape proof policy or evaluator identity is stale");
  }
  if (!sameStrings(expectedRegistrationIds, coveredRegistrationIds)) {
    errors.push("shape proof does not cover the current required registrations");
  }
  if (!sameStrings(expectedReferenceIds, coveredReferenceIds)) {
    errors.push("shape proof does not cover the current active reference set");
  }
  const expectedBatches: string[][] = [];
  for (let offset = 0; offset < expectedRegistrationIds.length; offset += SHAPE_PROOF_POLICY.evaluationBatchSize) {
    expectedBatches.push(expectedRegistrationIds.slice(offset, offset + SHAPE_PROOF_POLICY.evaluationBatchSize));
  }
  if (JSON.stringify(record.coverage.batches) !== JSON.stringify(expectedBatches)) {
    errors.push("shape proof does not use the deterministic registration batches");
  }
  const viewIds = record.views.map((view) => view.registration.id);
  if (new Set(viewIds).size !== viewIds.length || !sameStrings(viewIds, expectedRegistrationIds)) {
    errors.push("shape proof must contain exactly one view record per registration");
  }
  for (const registration of registrations) {
    const view = record.views.find((candidate) => candidate.registration.id === registration.registrationId);
    if (!view || view.registration.revision !== registration.revision ||
        view.registration.referenceId !== registration.referenceId ||
        view.registration.direction !== registration.direction) {
      errors.push(`shape proof view ${registration.registrationId} does not match its registration provenance`);
    }
    if (record.status === "passed" && view && (view.status !== "passed" || !view.metrics ||
        view.metrics.silhouetteIou < view.thresholds.silhouetteIouMin ||
        view.metrics.symmetricContourDistanceMm > view.thresholds.symmetricContourDistanceMmMax ||
        view.metrics.landmarks.some((landmark) => landmark.status !== "passed" ||
          (landmark.positionErrorMm !== undefined &&
            landmark.positionErrorMm > view.thresholds.landmarkPositionErrorMmMax)))) {
      errors.push(`shape proof view ${registration.registrationId} does not satisfy its immutable thresholds`);
    }
  }
  return errors;
}

function evidenceState(verdict: "passed" | "failed" | "error" | undefined): "proven" | "failed" | "unavailable" {
  if (verdict === "passed") return "proven";
  if (verdict === "failed") return "failed";
  return "unavailable";
}

function combinedStatus(states: readonly ProofEvidenceState[]): Exclude<ReportStatus, "stale"> {
  if (states.includes("failed")) return "failed";
  if (states.includes("unavailable")) return "unavailable";
  return "proven";
}

function reportIsStale(db: DatabaseSync, row: ProofReportRow, report: ProofReportDto): boolean {
  const artifact = latestArtifact(db, row.conversation_id);
  if (!artifact || artifact.id !== row.artifact_id || artifact.version !== row.artifact_version) return true;
  const contract = latestContract(db, row.conversation_id);
  if (!contract || contract.contract_id !== row.proof_contract_id || contract.revision !== row.proof_contract_revision) return true;
  const plan = latestPlan(messages(db, row.conversation_id));
  if (!plan || plan.domain.plan_id !== row.plan_id || plan.domain.criteria_revision !== row.criteria_revision) return true;
  const activeSpecificationIds = listLegacySourceSpecifications(db, row.conversation_id)
    .filter((specification) => specification.status === "active")
    .map((specification) => specification.id);
  if (!sameStrings(activeSpecificationIds, report.sourceSpecifications.map((specification) => specification.id))) return true;
  const activeReferenceIds = listLegacyReferenceRecords(db, row.conversation_id)
    .filter((reference) => reference.status === "active" || reference.status === "complementary")
    .map((reference) => reference.referenceId);
  const registrationIds = listLegacyReferenceRegistrations(db, row.conversation_id)
    .filter((registration) => registration.status === "current" && activeReferenceIds.includes(registration.referenceId))
    .map((registration) => `${registration.registrationId}@${registration.revision}`);
  const reportRegistrationIds = (report.referenceRegistrations ?? [])
    .map((registration) => `${registration.registrationId}@${registration.revision}`);
  if (!sameStrings(registrationIds, reportRegistrationIds)) return true;
  if (!sameStrings(
    activeReferenceIds,
    (report.referenceRegistrations ?? []).map((registration) => registration.referenceId),
  )) return true;
  if (report.visualVerification.state !== "not-applicable") {
    const visual = report.visualVerification.record;
    const latestVisual = listLegacyVisualVerifications(db, row.conversation_id).at(-1);
    if (!visual) return latestVisual !== undefined;
    if (!sameStrings(activeReferenceIds, visual.coveredReferenceIds) || latestVisual?.id !== visual.id) return true;
  }
  return false;
}

function toDto(db: DatabaseSync, row: ProofReportRow): ProofReportDto {
  const report = JSON.parse(row.payload_json) as ProofReportDto;
  if (!reportIsStale(db, row, report)) return report;
  return {
    ...report,
    status: "stale",
    proofContract: {
      ...report.proofContract,
      status: "stale",
      proofStatus: "stale",
    },
  };
}

export function listLegacyProofReports(db: DatabaseSync, conversationId: string): ProofReportDto[] {
  const rows = db.prepare(
    "SELECT * FROM proof_reports WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC",
  ).all(conversationId) as unknown as ProofReportRow[];
  return rows.map((row) => toDto(db, row));
}

export function listProofReports(db: DatabaseSync, conversationId: string): ProofReportDto[] {
  return projectEvidence(db, conversationId).proofReports;
}

function validateInput(input: CreateProofReportInput): void {
  const positiveInteger = (value: number) => Number.isInteger(value) && value > 0;
  if (!input || typeof input !== "object" ||
    typeof input.proofContractId !== "string" || !input.proofContractId ||
    !positiveInteger(input.proofContractRevision) ||
    typeof input.planId !== "string" || !input.planId ||
    !positiveInteger(input.planRevision) || !positiveInteger(input.criteriaRevision) ||
    typeof input.artifactId !== "string" || !input.artifactId ||
    !positiveInteger(input.artifactVersion) ||
    typeof input.engineeringEvidenceId !== "string" || !input.engineeringEvidenceId ||
    (input.visualVerificationId !== undefined &&
      (typeof input.visualVerificationId !== "string" || !input.visualVerificationId))) {
    throw new ProofReportError("a complete proof-report identity is required");
  }
}

export function createProofReport(
  db: DatabaseSync,
  conversationId: string,
  input: CreateProofReportInput,
  idempotencyKey: string,
): ProofReportDto {
  validateInput(input);
  if (!idempotencyKey.trim()) throw new ProofReportError("Idempotency-Key is required");
  const projection = projectEvidence(db, conversationId);
  const replay = projection.events.find((event) => event.type === "proof-report.recorded" &&
    event.data.commandIdempotencyKey === idempotencyKey);
  if (replay?.type === "proof-report.recorded") {
    if (JSON.stringify(replay.data.request) !== JSON.stringify(input)) {
      throw new ProofReportError("idempotency key conflicts with an existing proof report request", "conflict");
    }
    return replay.data.report;
  }

  const records = messages(db, conversationId);
  const plan = isDomainPlan(projection.activePlan) ? projection.activePlan : undefined;
  if (!plan || plan.domain.plan_id !== input.planId || plan.domain.revision !== input.planRevision ||
    plan.domain.criteria_revision !== input.criteriaRevision) {
    throw new ProofReportError("the accepted design-plan identity is stale or belongs to another conversation", "conflict");
  }
  const contract = projection.proofContracts.find((candidate) => candidate.contractId === input.proofContractId &&
    candidate.revision === input.proofContractRevision && candidate.status === "current");
  if (!contract) {
    throw new ProofReportError("the proof-contract identity is stale or belongs to another conversation", "conflict");
  }
  if (contract.derivation.planId !== input.planId || contract.derivation.criteriaRevision !== input.criteriaRevision ||
    contract.derivation.planRevision > input.planRevision) {
    throw new ProofReportError("the proof contract does not govern the accepted design plan", "conflict");
  }
  const artifact = latestArtifact(db, conversationId);
  if (!artifact || artifact.id !== input.artifactId || artifact.version !== input.artifactVersion) {
    throw new ProofReportError("the CAD artifact identity is stale or belongs to another conversation", "conflict");
  }
  const evidence = evidenceRecord(records, input.engineeringEvidenceId);
  if (!evidence || evidence.details?.code?.artifactId !== input.artifactId ||
    evidence.details.code.artifactVersion !== input.artifactVersion) {
    throw new ProofReportError("the engineering evidence does not identify the requested CAD artifact", "conflict");
  }
  const specifications = listSourceSpecifications(db, conversationId)
    .filter((specification) => specification.status === "active");
  const specificationIds = specifications.map((specification) => specification.id);
  if (!sameStrings(specificationIds, contract.derivation.sourceSpecificationIds) ||
    !sameStrings(specificationIds, plan.domain.source_specification_ids)) {
    throw new ProofReportError("the governing design specifications changed after the proof contract was frozen", "conflict");
  }
  const activeComponents = plan.components.filter((component) =>
    component.status !== "abandoned" && component.retired_revision === undefined,
  );
  if (activeComponents.length !== 1 || activeComponents[0]?.id !== contract.derivation.component.id) {
    throw new ProofReportError("the accepted plan and proof contract do not identify one matching component", "conflict");
  }

  const activeReferenceIds = listReferenceRecords(db, conversationId)
    .filter((reference) => reference.status === "active" || reference.status === "complementary")
    .map((reference) => reference.referenceId);
  const referenceRegistrations = currentReferenceRegistrations(db, conversationId, contract);
  const referenceBacked = contract.derivation.shapeProof.status !== "not-applicable";
  if (referenceBacked && !sameStrings(
    activeReferenceIds,
    referenceRegistrations.map((registration) => registration.referenceId),
  )) {
    throw new ProofReportError("the active reference set does not match the proof contract registrations", "conflict");
  }

  const gate = gateRecord(evidence.details?.gate);
  const conformance = planConformanceRecord(evidence.details?.planConformance);
  const measurements = measurementsRecord(evidence.details?.measurements);
  if (!measurements) throw new ProofReportError("the engineering evidence has no inspectable measurements", "conflict");
  if (conformance && (conformance.planId !== input.planId ||
    conformance.componentCriteriaRevisions[contract.derivation.component.id] !== input.criteriaRevision)) {
    throw new ProofReportError("the engineering evidence is bound to stale plan criteria", "conflict");
  }
  const shapeProof = shapeProofRecord(evidence.details?.shapeProof);
  if (shapeProof) {
    const shapeErrors = shapeProofIdentityErrors(
      shapeProof,
      input,
      contract,
      referenceRegistrations,
      activeReferenceIds,
    );
    if (shapeErrors.length > 0) throw new ProofReportError(shapeErrors.join("; "), "conflict");
  }
  if (contract.derivation.shapeProof.status === "required" && !shapeProof) {
    throw new ProofReportError("the engineering evidence has no independent shape-proof record", "conflict");
  }

  const visual = input.visualVerificationId
    ? listVisualVerifications(db, conversationId).find((record) => record.id === input.visualVerificationId)
    : undefined;
  if (input.visualVerificationId && !visual) {
    throw new ProofReportError("visual verification identity is unavailable or belongs to another conversation", "conflict");
  }
  if (!referenceBacked && input.visualVerificationId) {
    throw new ProofReportError("text-only proof reports cannot bind visual verification", "conflict");
  }
  if (visual && (visual.artifactId !== input.artifactId || visual.artifactVersion !== input.artifactVersion ||
      visual.inspectionSheetId !== evidence.details?.inspectionSheet?.attachmentId ||
      !sameStrings(visual.coveredReferenceIds, activeReferenceIds))) {
    throw new ProofReportError("visual verification does not match the current artifact, inspection sheet, or reference set", "conflict");
  }
  if (referenceBacked && shapeProof?.status === "passed" && !visual) {
    throw new ProofReportError("passing shape proof requires matching semantic visual verification", "conflict");
  }
  if (referenceBacked && shapeProof?.status === "passed" && activeComponents[0]?.status !== "done") {
    throw new ProofReportError("proven finalization requires the accepted component to be complete", "conflict");
  }
  const gateState = evidenceState(gate?.status);
  const conformanceState = evidenceState(conformance?.status);
  const integrity = measurements.integrity ?? null;
  const integrityState = integrity?.status === "conforming"
    ? "proven" as const
    : integrity?.status === "nonconforming"
      ? "failed" as const
      : "unavailable" as const;
  const engineeringState = combinedStatus([gateState, conformanceState]);
  const shapeState = !referenceBacked
    ? "not-applicable" as const
    : contract.derivation.shapeProof.status === "unavailable"
      ? "unavailable" as const
      : shapeProof?.status === "passed"
        ? "proven" as const
        : shapeProof?.status === "failed"
          ? "failed" as const
          : "unavailable" as const;
  const visualState = !referenceBacked
    ? "not-applicable" as const
    : visual?.verdict === "match"
      ? "proven" as const
      : visual?.verdict === "needs-revision"
        ? "failed" as const
        : "unavailable" as const;
  const reportStatus = combinedStatus([
    engineeringState,
    integrityState,
    ...(shapeState === "not-applicable" ? [] : [shapeState]),
    ...(visualState === "not-applicable" ? [] : [visualState]),
  ]);
  const createdAt = Date.now();
  const report: ProofReportDto = {
    reportId: crypto.randomUUID(),
    conversationId,
    createdAt,
    status: reportStatus,
    proofContract: contract,
    acceptedPlan: {
      planId: input.planId,
      revision: input.planRevision,
      criteriaRevision: input.criteriaRevision,
      goal: plan.goal,
      componentId: contract.derivation.component.id,
      snapshot: structuredClone(plan) as unknown as Record<string, unknown>,
    },
    sourceSpecifications: specifications,
    referenceRegistrations,
    cadArtifact: { id: artifact.id, version: artifact.version, createdAt: artifact.created_at },
    engineering: {
      state: engineeringState,
      evidenceId: input.engineeringEvidenceId,
      verificationGate: {
        state: gateState,
        verdict: gate?.status ?? "unavailable",
        checks: gate?.checks ?? [],
        ...(gate?.checkSet ? { checkSet: gate.checkSet } : {}),
      },
      planConformance: {
        state: conformanceState,
        verdict: conformance?.status ?? "unavailable",
        ...(conformance ? { planId: conformance.planId } : {}),
        componentCriteriaRevisions: conformance?.componentCriteriaRevisions ?? {},
      },
      measurements,
    },
    bodyIntegrity: { state: integrityState, verdict: integrity },
    shapeProof: shapeState === "not-applicable"
      ? { state: shapeState, reason: contract.derivation.shapeProof.reason }
      : {
          state: shapeState,
          reason: shapeProof?.worst.detail ?? contract.derivation.shapeProof.reason,
          record: shapeProof ?? null,
        },
    visualVerification: visualState === "not-applicable"
      ? { state: visualState, reason: "No active reference image governs this text-only deliverable." }
      : {
          state: visualState,
          reason: visual
            ? `Semantic visual verification ${visual.id} recorded verdict ${visual.verdict}.`
            : "Semantic visual verification is not yet available for this artifact.",
          record: visual ?? null,
        },
    assumptions: contract.derivation.criteria.filter((criterion) => criterion.category === "agent-assumption"),
    unavailableEvidence: contract.derivation.unavailableEvidence,
  };

  const existingTarget = projection.proofReports.find((candidate) =>
    candidate.cadArtifact.id === input.artifactId && candidate.cadArtifact.version === input.artifactVersion);
  if (existingTarget) {
    const sameTarget = existingTarget.proofContract.contractId === input.proofContractId &&
      existingTarget.proofContract.revision === input.proofContractRevision &&
      existingTarget.acceptedPlan.planId === input.planId &&
      existingTarget.acceptedPlan.revision === input.planRevision &&
      existingTarget.engineering.evidenceId === input.engineeringEvidenceId &&
      (existingTarget.visualVerification.state === "not-applicable"
        ? input.visualVerificationId === undefined
        : existingTarget.visualVerification.record?.id === input.visualVerificationId);
    if (!sameTarget) throw new ProofReportError("the CAD artifact already has a conflicting proof report", "conflict");
    return existingTarget;
  }
  appendEvidenceEvent(db, conversationId, {
    id: `${conversationId}:proof-report:${report.reportId}`,
    type: "proof-report.recorded",
    data: { report, commandIdempotencyKey: idempotencyKey, request: input },
  });
  return report;
}
