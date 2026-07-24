import type {
  CadEnvironment,
  ClassifyReferenceInput,
  CreateProofContractInput,
  CreateProofReportInput,
  CreateReferenceRegistrationInput,
  DesignEscalationDto,
  InspectionLeaseDto,
  InspectionObservationInput,
  Gate,
  Measurements,
  InspectEvidenceInput,
  MeasuredVisualComparisonEvidence,
  OpenDesignEscalationInput,
  ProofContractDto,
  ProofReportDto,
  ReferenceClassificationDto,
  ReferenceRecordDto,
  ReferenceRegistrationDto,
  RecordSourceSpecificationsInput,
  RecordVisualVerificationBatchInput,
  RecordVisualVerificationInput,
  SourceSpecificationDto,
  VisualVerificationBatchRecordDto,
  VisualVerificationRecordDto,
} from "./index";
import type { CheckSetComparison, FrozenVerificationCheck } from "./verificationChecks";
import { Type } from "typebox";

interface EvidenceEventBase<TType extends string, TData> {
  id: string;
  conversationId: string;
  sequence: number;
  recordedAt: number;
  type: TType;
  data: TData;
}

export interface PlanCheckChangeEvidence {
  componentId: string;
  checkId: string;
  kind: "changed" | "retired";
  before: unknown;
  after?: unknown;
}

export interface CadEnvironmentVerificationEvidence {
  environment: CadEnvironment;
  /** A Local code revision is a complete design candidate. Fusion actions are
   * incremental changes; only a trusted read-only inspection is design scope. */
  scope: "change" | "design";
  candidateId: string;
  status: "passed" | "failed" | "unavailable";
  revision?: string;
  inspectionId?: string;
  artifact?: { id: string; version: number };
  measurements: {
    bodyCount: number;
    boundingBoxMm?: [number, number, number];
    volumeMm3: number;
  };
  views: string[];
  checks: Array<{
    name: string;
    status: "passed" | "failed" | "unavailable";
    detail: string;
  }>;
}

export interface VerificationCheckRevisionAttemptEvidence {
  attemptId: string;
  planId: string;
  priorContractId?: string;
  priorContractRevision?: number;
  proposedCriteriaRevision: number;
  proposedChecks: FrozenVerificationCheck[];
  comparison: CheckSetComparison;
  status: "accepted" | "held";
  reason?: string;
  authorizedByEscalationId?: string;
  authorizedBySourceSpecificationIds?: string[];
  attemptedAt: number;
}

export type EvidenceEvent =
  | EvidenceEventBase<"artifact.verified", {
      artifactId: string;
      artifactVersion: number;
      gate: Gate;
      measurements: Measurements;
    }>
  | EvidenceEventBase<"environment-verification.recorded", CadEnvironmentVerificationEvidence>
  | EvidenceEventBase<"plan.recorded", {
      operation: "created" | "revised" | "legacy-snapshot";
      plan: unknown;
      checkChanges?: PlanCheckChangeEvidence[];
    }>
  | EvidenceEventBase<"source-specifications.recorded", {
      specifications: SourceSpecificationDto[];
      commandIdempotencyKey?: string;
    }>
  | EvidenceEventBase<"proof-contract.frozen", {
      contract: ProofContractDto;
    }>
  | EvidenceEventBase<"verification-checks.revision-attempted", {
      attempt: VerificationCheckRevisionAttemptEvidence;
    }>
  | EvidenceEventBase<"reference.classified", {
      classification: ReferenceClassificationDto;
      attachmentAvailable: boolean;
    }>
  | EvidenceEventBase<"reference.registered", {
      registration: ReferenceRegistrationDto;
      commandIdempotencyKey?: string;
    }>
  | EvidenceEventBase<"inspection-lease.opened" | "inspection-lease.closed", {
      lease: InspectionLeaseDto;
      commandIdempotencyKey?: string;
    }>
  | EvidenceEventBase<"visual-comparison.recorded", {
      comparison: MeasuredVisualComparisonEvidence;
      commandIdempotencyKey?: string;
    }>
  | EvidenceEventBase<"visual-verification.recorded", {
      verification: VisualVerificationRecordDto;
      commandIdempotencyKey?: string;
    }>
  | EvidenceEventBase<"visual-verification-batch.recorded", {
      batch: VisualVerificationBatchRecordDto;
      commandIdempotencyKey?: string;
    }>
  | EvidenceEventBase<"proof-report.recorded", {
      report: ProofReportDto;
      commandIdempotencyKey?: string;
      request?: CreateProofReportInput;
    }>
  | EvidenceEventBase<"proof-reports.invalidated", {
      latestArtifactVersion: number;
    }>
  | EvidenceEventBase<"design-escalation.opened" | "design-escalation.resolved", {
      escalation: DesignEscalationDto;
      openedAfterMessageSeq?: number;
      commandIdempotencyKey?: string;
    }>;

export type EvidenceEventDraft = EvidenceEvent extends infer TEvent
  ? TEvent extends EvidenceEvent
    ? Pick<TEvent, "id" | "type" | "data"> & { recordedAt?: number }
    : never
  : never;

/** Commands preserve the existing agent-tool input contracts while one server
 * route translates them into immutable ledger events. */
export type EvidenceCommand =
  | {
      type: "record-environment-verification";
      event: Extract<EvidenceEventDraft, { type: "environment-verification.recorded" }>;
    }
  | { type: "record-plan"; event: Extract<EvidenceEventDraft, { type: "plan.recorded" }> }
  | {
      type: "record-verification-check-revision-attempt";
      event: Extract<EvidenceEventDraft, { type: "verification-checks.revision-attempted" }>;
    }
  | { type: "record-source-specifications"; input: RecordSourceSpecificationsInput; idempotencyKey: string }
  | { type: "freeze-proof-contract"; input: CreateProofContractInput; idempotencyKey: string }
  | { type: "create-proof-report"; input: CreateProofReportInput; idempotencyKey: string }
  | { type: "open-design-escalation"; input: OpenDesignEscalationInput; idempotencyKey: string }
  | { type: "classify-reference"; input: ClassifyReferenceInput; idempotencyKey: string }
  | { type: "register-reference"; input: CreateReferenceRegistrationInput; idempotencyKey: string }
  | { type: "open-inspection-lease"; input: InspectEvidenceInput; idempotencyKey: string }
  | {
      type: "record-inspection-observation";
      leaseId: string;
      input: InspectionObservationInput;
      idempotencyKey: string;
    }
  | { type: "record-visual-comparison"; input: MeasuredVisualComparisonEvidence; idempotencyKey: string }
  | { type: "record-visual-verification"; input: RecordVisualVerificationInput; idempotencyKey: string }
  | { type: "record-visual-verification-batch"; input: RecordVisualVerificationBatchInput; idempotencyKey: string };

const NonEmptyStringSchema = Type.String({ minLength: 1 });
const PositiveIntegerSchema = Type.Integer({ minimum: 1 });
const OpenObjectSchema = Type.Record(Type.String(), Type.Unknown());
const PlanIdentitySchema = Type.Union([
  Type.Object({ id: NonEmptyStringSchema, revision: PositiveIntegerSchema }, { additionalProperties: true }),
  Type.Object({
    domain: Type.Object({
      plan_id: NonEmptyStringSchema,
      revision: PositiveIntegerSchema,
    }, { additionalProperties: true }),
  }, { additionalProperties: true }),
  Type.Object({
    goal: Type.String(),
    components: Type.Array(Type.Unknown()),
  }, { additionalProperties: true }),
]);
const EventDraftOptions = { additionalProperties: false } as const;
const VisualComparisonViewSchema = Type.Union([
  Type.Literal("isometric"), Type.Literal("front"), Type.Literal("back"), Type.Literal("left"),
  Type.Literal("right"), Type.Literal("top"), Type.Literal("bottom"), Type.Literal("section"),
]);
const VisualComparisonTargetSchema = Type.Object({
  kind: Type.Union([Type.Literal("prior-accepted-artifact"), Type.Literal("registered-render")]),
  id: NonEmptyStringSchema,
  artifactId: Type.Optional(NonEmptyStringSchema),
  artifactVersion: Type.Optional(PositiveIntegerSchema),
  inspectionSheetId: Type.Optional(NonEmptyStringSchema),
  referenceId: Type.Optional(NonEmptyStringSchema),
}, EventDraftOptions);
const MeasuredVisualComparisonSchema = Type.Unsafe<MeasuredVisualComparisonEvidence>(Type.Object({
  evidenceId: NonEmptyStringSchema,
  status: Type.Union([
    Type.Literal("match"),
    Type.Literal("mismatch"),
    Type.Literal("unavailable"),
    Type.Literal("not-applicable"),
  ]),
  policy: Type.Object({ id: NonEmptyStringSchema, version: PositiveIntegerSchema }, EventDraftOptions),
  algorithm: Type.Object({ id: NonEmptyStringSchema, version: PositiveIntegerSchema }, EventDraftOptions),
  thresholds: Type.Object({
    silhouetteOverlapMin: Type.Number(),
    edgeAlignmentMin: Type.Number(),
    edgeTolerancePx: Type.Number({ minimum: 0 }),
  }, EventDraftOptions),
  candidate: Type.Object({
    artifactId: NonEmptyStringSchema,
    artifactVersion: PositiveIntegerSchema,
    inspectionSheetId: NonEmptyStringSchema,
  }, EventDraftOptions),
  comparisons: Type.Array(Type.Object({
    target: VisualComparisonTargetSchema,
    status: Type.Union([Type.Literal("match"), Type.Literal("mismatch"), Type.Literal("unavailable")]),
    views: Type.Array(Type.Object({
      view: VisualComparisonViewSchema,
      verdict: Type.Union([Type.Literal("match"), Type.Literal("mismatch")]),
      silhouetteOverlap: Type.Number(),
      edgeAlignment: Type.Number(),
      deviation: Type.Object({
        columns: PositiveIntegerSchema,
        rows: PositiveIntegerSchema,
        regions: Type.Array(Type.Object({
          column: Type.Integer({ minimum: 0 }),
          row: Type.Integer({ minimum: 0 }),
          x: Type.Number(),
          y: Type.Number(),
          width: Type.Number({ minimum: 0 }),
          height: Type.Number({ minimum: 0 }),
          deviation: Type.Number(),
        }, EventDraftOptions)),
      }, EventDraftOptions),
    }, EventDraftOptions)),
    reason: Type.Optional(Type.String()),
  }, EventDraftOptions)),
  reason: Type.Optional(Type.String()),
}, EventDraftOptions));
const eventDraft = <TType extends string>(type: TType, data: ReturnType<typeof Type.Object>) => Type.Object({
  id: NonEmptyStringSchema,
  type: Type.Literal(type),
  data,
  recordedAt: Type.Optional(Type.Number()),
}, EventDraftOptions);

const PlanRecordedEventDraftSchema = eventDraft("plan.recorded", Type.Object({
    operation: Type.Union([Type.Literal("created"), Type.Literal("revised"), Type.Literal("legacy-snapshot")]),
    plan: PlanIdentitySchema,
    checkChanges: Type.Optional(Type.Array(Type.Object({
      componentId: NonEmptyStringSchema,
      checkId: NonEmptyStringSchema,
      kind: Type.Union([Type.Literal("changed"), Type.Literal("retired")]),
      before: Type.Unknown(),
      after: Type.Optional(Type.Unknown()),
    }, EventDraftOptions))),
  }, EventDraftOptions));

const EnvironmentVerificationDataSchema = Type.Object({
  environment: Type.Union([Type.Literal("build123d"), Type.Literal("fusion")]),
  scope: Type.Union([Type.Literal("change"), Type.Literal("design")]),
  candidateId: NonEmptyStringSchema,
  status: Type.Union([Type.Literal("passed"), Type.Literal("failed"), Type.Literal("unavailable")]),
  revision: Type.Optional(NonEmptyStringSchema),
  inspectionId: Type.Optional(NonEmptyStringSchema),
  artifact: Type.Optional(Type.Object({
    id: NonEmptyStringSchema,
    version: Type.Integer({ minimum: 0 }),
  }, EventDraftOptions)),
  measurements: Type.Object({
    bodyCount: Type.Integer({ minimum: 0 }),
    boundingBoxMm: Type.Optional(Type.Array(Type.Number(), { minItems: 3, maxItems: 3 })),
    volumeMm3: Type.Number({ minimum: 0 }),
  }, EventDraftOptions),
  views: Type.Array(Type.String()),
  checks: Type.Array(Type.Object({
    name: NonEmptyStringSchema,
    status: Type.Union([Type.Literal("passed"), Type.Literal("failed"), Type.Literal("unavailable")]),
    detail: Type.String(),
  }, EventDraftOptions)),
}, EventDraftOptions);

const EnvironmentVerificationEventDraftSchema = eventDraft(
  "environment-verification.recorded",
  EnvironmentVerificationDataSchema,
);

export const EvidenceEventDraftSchema = Type.Unsafe<EvidenceEventDraft>(Type.Union([
  eventDraft("artifact.verified", Type.Object({
    artifactId: NonEmptyStringSchema,
    artifactVersion: PositiveIntegerSchema,
    gate: OpenObjectSchema,
    measurements: OpenObjectSchema,
  }, EventDraftOptions)),
  EnvironmentVerificationEventDraftSchema,
  PlanRecordedEventDraftSchema,
  eventDraft("source-specifications.recorded", Type.Object({
    specifications: Type.Array(OpenObjectSchema),
    commandIdempotencyKey: Type.Optional(NonEmptyStringSchema),
  }, EventDraftOptions)),
  eventDraft("proof-contract.frozen", Type.Object({ contract: OpenObjectSchema }, EventDraftOptions)),
  eventDraft("verification-checks.revision-attempted", Type.Object({ attempt: OpenObjectSchema }, EventDraftOptions)),
  eventDraft("reference.classified", Type.Object({ classification: OpenObjectSchema, attachmentAvailable: Type.Boolean() }, EventDraftOptions)),
  eventDraft("reference.registered", Type.Object({
    registration: OpenObjectSchema,
    commandIdempotencyKey: Type.Optional(NonEmptyStringSchema),
  }, EventDraftOptions)),
  eventDraft("inspection-lease.opened", Type.Object({
    lease: OpenObjectSchema,
    commandIdempotencyKey: Type.Optional(NonEmptyStringSchema),
  }, EventDraftOptions)),
  eventDraft("inspection-lease.closed", Type.Object({
    lease: OpenObjectSchema,
    commandIdempotencyKey: Type.Optional(NonEmptyStringSchema),
  }, EventDraftOptions)),
  eventDraft("visual-comparison.recorded", Type.Object({
    comparison: MeasuredVisualComparisonSchema,
    commandIdempotencyKey: Type.Optional(NonEmptyStringSchema),
  }, EventDraftOptions)),
  eventDraft("visual-verification.recorded", Type.Object({
    verification: OpenObjectSchema,
    commandIdempotencyKey: Type.Optional(NonEmptyStringSchema),
  }, EventDraftOptions)),
  eventDraft("visual-verification-batch.recorded", Type.Object({
    batch: OpenObjectSchema,
    commandIdempotencyKey: Type.Optional(NonEmptyStringSchema),
  }, EventDraftOptions)),
  eventDraft("proof-report.recorded", Type.Object({
    report: OpenObjectSchema,
    commandIdempotencyKey: Type.Optional(NonEmptyStringSchema),
    request: Type.Optional(OpenObjectSchema),
  }, EventDraftOptions)),
  eventDraft("proof-reports.invalidated", Type.Object({ latestArtifactVersion: PositiveIntegerSchema }, EventDraftOptions)),
  eventDraft("design-escalation.opened", Type.Object({
    escalation: OpenObjectSchema,
    openedAfterMessageSeq: Type.Optional(Type.Integer()),
    commandIdempotencyKey: Type.Optional(NonEmptyStringSchema),
  }, EventDraftOptions)),
  eventDraft("design-escalation.resolved", Type.Object({
    escalation: OpenObjectSchema,
    openedAfterMessageSeq: Type.Optional(Type.Integer()),
    commandIdempotencyKey: Type.Optional(NonEmptyStringSchema),
  }, EventDraftOptions)),
]));

const keyedCommand = <TType extends string>(type: TType) => Type.Object({
  type: Type.Literal(type),
  input: OpenObjectSchema,
  idempotencyKey: NonEmptyStringSchema,
}, EventDraftOptions);

export const EvidenceCommandSchema = Type.Unsafe<EvidenceCommand>(Type.Union([
  Type.Object({
    type: Type.Literal("record-environment-verification"),
    event: EnvironmentVerificationEventDraftSchema,
  }, EventDraftOptions),
  Type.Object({ type: Type.Literal("record-plan"), event: PlanRecordedEventDraftSchema }, EventDraftOptions),
  Type.Object({
    type: Type.Literal("record-verification-check-revision-attempt"),
    event: eventDraft(
      "verification-checks.revision-attempted",
      Type.Object({ attempt: OpenObjectSchema }, EventDraftOptions),
    ),
  }, EventDraftOptions),
  keyedCommand("record-source-specifications"),
  keyedCommand("freeze-proof-contract"),
  keyedCommand("create-proof-report"),
  keyedCommand("open-design-escalation"),
  keyedCommand("classify-reference"),
  keyedCommand("register-reference"),
  keyedCommand("open-inspection-lease"),
  Type.Object({
    type: Type.Literal("record-inspection-observation"),
    leaseId: NonEmptyStringSchema,
    input: OpenObjectSchema,
    idempotencyKey: NonEmptyStringSchema,
  }, EventDraftOptions),
  Type.Object({
    type: Type.Literal("record-visual-comparison"),
    input: MeasuredVisualComparisonSchema,
    idempotencyKey: NonEmptyStringSchema,
  }, EventDraftOptions),
  keyedCommand("record-visual-verification"),
  keyedCommand("record-visual-verification-batch"),
]));

export interface EvidenceProjection {
  /** Full immutable history retained for audit and deterministic evaluation replay. */
  events: EvidenceEvent[];
  artifactVerifications?: Array<Extract<EvidenceEvent, { type: "artifact.verified" }>>;
  activePlan?: unknown;
  planHistory: Array<Extract<EvidenceEvent, { type: "plan.recorded" }>>;
  planCheckChanges: PlanCheckChangeEvidence[];
  sourceSpecifications: SourceSpecificationDto[];
  proofContracts: ProofContractDto[];
  verificationCheckRevisionAttempts: VerificationCheckRevisionAttemptEvidence[];
  referenceRecords: ReferenceRecordDto[];
  referenceRegistrations: ReferenceRegistrationDto[];
  inspectionLeases: InspectionLeaseDto[];
  visualComparisons: MeasuredVisualComparisonEvidence[];
  visualVerifications: VisualVerificationRecordDto[];
  visualVerificationBatches: VisualVerificationBatchRecordDto[];
  proofReports: ProofReportDto[];
  designEscalations: DesignEscalationDto[];
  environmentVerifications: CadEnvironmentVerificationEvidence[];
}

function replaceBy<T>(items: readonly T[], value: T, same: (left: T, right: T) => boolean): T[] {
  const index = items.findIndex((item) => same(item, value));
  if (index < 0) return [...items, value];
  return items.map((item, itemIndex) => itemIndex === index ? value : item);
}

export function evidencePlanIdentity(plan: unknown): { id: string; revision: number; criteriaRevision?: number } | undefined {
  if (typeof plan !== "object" || plan === null) return undefined;
  const candidate = plan as {
    id?: unknown;
    revision?: unknown;
    domain?: { plan_id?: unknown; revision?: unknown; criteria_revision?: unknown };
  };
  if (typeof candidate.domain?.plan_id === "string" && Number.isInteger(candidate.domain.revision)) {
    return {
      id: candidate.domain.plan_id,
      revision: candidate.domain.revision as number,
      ...(Number.isInteger(candidate.domain.criteria_revision)
        ? { criteriaRevision: candidate.domain.criteria_revision as number }
        : {}),
    };
  }
  if (typeof candidate.id === "string" && Number.isInteger(candidate.revision)) {
    return { id: candidate.id, revision: candidate.revision as number };
  }
  return undefined;
}

function staleContract(contract: ProofContractDto): ProofContractDto {
  return { ...contract, status: "stale", proofStatus: "stale" };
}

function applySpecifications(
  current: readonly SourceSpecificationDto[],
  recorded: readonly SourceSpecificationDto[],
): SourceSpecificationDto[] {
  const byId = new Map(current.map((item) => [item.id, item]));
  for (const specification of recorded) {
    const supersededIds = specification.supersedesSpecificationIds ??
      (specification.supersedesSpecificationId ? [specification.supersedesSpecificationId] : []);
    for (const supersededId of supersededIds) {
      const superseded = byId.get(supersededId);
      if (superseded) {
        byId.set(supersededId, {
          ...superseded,
          status: "superseded",
          supersededBySpecificationId: specification.id,
        });
      }
    }
    byId.set(specification.id, specification);
  }
  return [...byId.values()];
}

function applyClassification(
  current: readonly ReferenceRecordDto[],
  classification: ReferenceClassificationDto,
  attachmentAvailable: boolean,
): ReferenceRecordDto[] {
  const prior = current.find((record) => record.referenceId === classification.referenceId);
  const record: ReferenceRecordDto = {
    referenceId: classification.referenceId,
    conversationId: classification.conversationId,
    attachmentAvailable,
    status: classification.status,
    purpose: classification.purpose,
    relationships: classification.relationships,
    rationale: classification.rationale,
    specificationIds: classification.specificationIds,
    specificationLinks: classification.specificationLinks,
    legacySpecificationLinks: classification.legacySpecificationLinks,
    noSpecificationReason: classification.noSpecificationReason,
    actor: classification.actor,
    timestamp: classification.timestamp,
    history: [
      ...(prior?.history ?? []).filter((item) => item.id !== classification.id),
      classification,
    ],
  };
  return replaceBy(current, record, (left, right) => left.referenceId === right.referenceId);
}

function emptyEvidenceProjection(): EvidenceProjection {
  return {
    events: [],
    artifactVerifications: [],
    planHistory: [],
    planCheckChanges: [],
    sourceSpecifications: [],
    proofContracts: [],
    verificationCheckRevisionAttempts: [],
    referenceRecords: [],
    referenceRegistrations: [],
    inspectionLeases: [],
    visualComparisons: [],
    visualVerifications: [],
    visualVerificationBatches: [],
    proofReports: [],
    designEscalations: [],
    environmentVerifications: [],
  };
}

/** Advances an owned projection in place so hot server paths allocate only for new events. */
export function advanceEvidenceProjection(
  events: readonly EvidenceEvent[],
  initial?: EvidenceProjection,
): EvidenceProjection {
  const lastSequence = initial?.events.at(-1)?.sequence ?? 0;
  const ordered = [...events]
    .filter((event) => event.sequence > lastSequence)
    .sort((left, right) => left.sequence - right.sequence);
  const projection = initial ?? emptyEvidenceProjection();

  for (const event of ordered) {
    projection.events.push(event);
    switch (event.type) {
      case "artifact.verified":
        projection.artifactVerifications!.push(event);
        break;
      case "environment-verification.recorded":
        projection.environmentVerifications.push(event.data);
        break;
      case "plan.recorded":
        projection.planHistory.push(event);
        projection.planCheckChanges.push(...(event.data.checkChanges ?? []));
        projection.activePlan = event.data.plan;
        {
          const identity = evidencePlanIdentity(event.data.plan);
          if (identity) projection.proofContracts = projection.proofContracts.map((contract) =>
            contract.derivation.planId === identity.id &&
              contract.derivation.criteriaRevision === (identity.criteriaRevision ?? identity.revision)
              ? contract
              : staleContract(contract));
        }
        break;
      case "proof-reports.invalidated":
        projection.proofReports = projection.proofReports.map((report) =>
          report.cadArtifact.version < event.data.latestArtifactVersion
            ? { ...report, status: "stale" as const }
            : report);
        break;
      case "source-specifications.recorded":
        {
          const supersededIds = new Set(event.data.specifications.flatMap((specification) =>
            specification.supersedesSpecificationIds ??
            (specification.supersedesSpecificationId ? [specification.supersedesSpecificationId] : [])));
          projection.proofContracts = projection.proofContracts.map((contract) =>
            contract.derivation.sourceSpecificationIds.some((id) => supersededIds.has(id))
              ? staleContract(contract)
              : contract);
        }
        projection.sourceSpecifications = applySpecifications(
          projection.sourceSpecifications,
          event.data.specifications,
        );
        break;
      case "proof-contract.frozen":
        projection.proofContracts = [
          ...projection.proofContracts.map((contract) => ({
            ...contract,
            status: "stale" as const,
            proofStatus: "stale" as const,
          })),
          event.data.contract,
        ];
        break;
      case "verification-checks.revision-attempted":
        projection.verificationCheckRevisionAttempts.push(event.data.attempt);
        break;
      case "reference.classified":
        projection.referenceRecords = applyClassification(
          projection.referenceRecords,
          event.data.classification,
          event.data.attachmentAvailable,
        );
        if (event.data.classification.status === "superseded") {
          const retiredReferenceId = event.data.classification.referenceId;
          const retiredRegistrationIds = new Set(projection.referenceRegistrations
            .filter((registration) => registration.referenceId === retiredReferenceId)
            .map((registration) => registration.registrationId));
          projection.referenceRegistrations = projection.referenceRegistrations.map((registration) =>
            registration.referenceId === retiredReferenceId
              ? { ...registration, status: "stale" as const }
              : registration);
          projection.proofContracts = projection.proofContracts.map((contract) => {
            const registrations = contract.derivation.shapeProof.status === "not-applicable"
              ? []
              : contract.derivation.shapeProof.registrations;
            return registrations.some((registration) => retiredRegistrationIds.has(registration.registrationId))
              ? staleContract(contract)
              : contract;
          });
        }
        break;
      case "reference.registered":
        projection.referenceRegistrations = [
          ...projection.referenceRegistrations.map((registration) =>
            registration.registrationId === event.data.registration.registrationId
              ? { ...registration, status: "stale" as const }
              : registration),
          event.data.registration,
        ];
        projection.proofContracts = projection.proofContracts.map((contract) => {
          const registrations = contract.derivation.shapeProof.status === "not-applicable"
            ? []
            : contract.derivation.shapeProof.registrations;
          return registrations.some((registration) =>
            registration.registrationId === event.data.registration.registrationId &&
            registration.revision < event.data.registration.revision)
            ? staleContract(contract)
            : contract;
        });
        break;
      case "inspection-lease.opened":
      case "inspection-lease.closed":
        projection.inspectionLeases = replaceBy(
          projection.inspectionLeases,
          event.data.lease,
          (left, right) => left.id === right.id,
        );
        break;
      case "visual-comparison.recorded":
        projection.visualComparisons = replaceBy(
          projection.visualComparisons,
          event.data.comparison,
          (left, right) => left.evidenceId === right.evidenceId,
        );
        break;
      case "visual-verification.recorded":
        projection.visualVerifications = replaceBy(
          projection.visualVerifications,
          event.data.verification,
          (left, right) => left.id === right.id,
        );
        break;
      case "visual-verification-batch.recorded":
        projection.visualVerificationBatches = replaceBy(
          projection.visualVerificationBatches,
          event.data.batch,
          (left, right) => left.id === right.id,
        );
        if (event.data.batch.finalVerification) {
          projection.visualVerifications = replaceBy(
            projection.visualVerifications,
            event.data.batch.finalVerification,
            (left, right) => left.id === right.id,
          );
        }
        break;
      case "proof-report.recorded":
        projection.proofReports = replaceBy(
          projection.proofReports,
          event.data.report,
          (left, right) => left.reportId === right.reportId,
        );
        break;
      case "design-escalation.opened":
      case "design-escalation.resolved":
        projection.designEscalations = replaceBy(
          projection.designEscalations,
          event.data.escalation,
          (left, right) => left.escalationId === right.escalationId,
        );
        break;
    }
  }

  return projection;
}

export function evidenceProjection(
  events: readonly EvidenceEvent[],
  initial?: EvidenceProjection,
): EvidenceProjection {
  const projection = initial
    ? {
        ...initial,
        events: [...initial.events],
        artifactVerifications: [...(initial.artifactVerifications ?? [])],
        planHistory: [...initial.planHistory],
        planCheckChanges: [...initial.planCheckChanges],
        sourceSpecifications: [...initial.sourceSpecifications],
        proofContracts: [...initial.proofContracts],
        verificationCheckRevisionAttempts: [...initial.verificationCheckRevisionAttempts],
        referenceRecords: [...initial.referenceRecords],
        referenceRegistrations: [...initial.referenceRegistrations],
        inspectionLeases: [...initial.inspectionLeases],
        visualComparisons: [...initial.visualComparisons],
        visualVerifications: [...initial.visualVerifications],
        visualVerificationBatches: [...initial.visualVerificationBatches],
        proofReports: [...initial.proofReports],
        designEscalations: [...initial.designEscalations],
        environmentVerifications: [...initial.environmentVerifications],
      }
    : undefined;
  return advanceEvidenceProjection(events, projection);
}

export type EvidenceGateResult = { passed: true } | { passed: false; reason: string };

export function planGate(projection: EvidenceProjection): EvidenceGateResult {
  const plan = projection.activePlan as { goal?: unknown; components?: unknown } | undefined;
  const validLegacyPlan = typeof plan?.goal === "string" && Array.isArray(plan.components);
  return evidencePlanIdentity(plan) === undefined && !validLegacyPlan
    ? { passed: false, reason: "no active plan is recorded" }
    : { passed: true };
}

export function proofContractFreshnessGate(
  projection: EvidenceProjection,
  planId: string,
  criteriaRevision: number,
): EvidenceGateResult {
  const current = projection.proofContracts.find((contract) =>
    contract.status === "current" &&
    contract.derivation.planId === planId &&
    contract.derivation.criteriaRevision === criteriaRevision);
  return current
    ? { passed: true }
    : { passed: false, reason: `no current proof contract covers plan ${planId} criteria revision ${criteriaRevision}` };
}

export interface VisualCoverageTarget {
  artifactId: string;
  artifactVersion: number;
  inspectionSheetId: string;
  activeReferenceIds: string[];
}

export function visualCoverageGate(
  projection: EvidenceProjection,
  target: VisualCoverageTarget,
): EvidenceGateResult {
  const expected = [...target.activeReferenceIds].sort();
  const verification = projection.visualVerifications.find((candidate) =>
    candidate.verdict === "match" &&
    candidate.artifactId === target.artifactId &&
    candidate.artifactVersion === target.artifactVersion &&
    candidate.inspectionSheetId === target.inspectionSheetId &&
    JSON.stringify([...candidate.coveredReferenceIds].sort()) === JSON.stringify(expected));
  if (!verification) {
    return {
      passed: false,
      reason: "no matching visual verification covers the current artifact, inspection sheet, and active references",
    };
  }
  const comparison = projection.visualComparisons.find((candidate) =>
    candidate.evidenceId === verification.visualComparisonEvidenceId &&
    candidate.candidate.artifactId === target.artifactId &&
    candidate.candidate.artifactVersion === target.artifactVersion &&
    candidate.candidate.inspectionSheetId === target.inspectionSheetId);
  if (!comparison) {
    return {
      passed: false,
      reason: "no matching visual verification covers the current artifact, inspection sheet, and active references",
    };
  }
  if (comparison.status === "match" ||
      (comparison.status === "not-applicable" && comparison.comparisons.length === 0)) {
    return { passed: true };
  }
  return comparison.status === "unavailable" && comparison.comparisons.length > 0
    ? { passed: false, reason: "current measured visual comparison is unavailable for an existing baseline" }
    : comparison.status === "mismatch"
      ? { passed: false, reason: "current measured visual comparison does not match the existing baseline" }
      : {
          passed: false,
          reason: "current measured visual comparison is not valid for the available baseline state",
        };
}
