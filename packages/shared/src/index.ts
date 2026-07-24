import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { CheckSetComparison } from "./verificationChecks";

export const PROXY_AUTH_TOKEN = "chamfer-local";

export type Provider = "anthropic" | "openai" | "google";

/** Title given to a conversation at creation; auto-titling only ever replaces this. */
export const DEFAULT_CONVERSATION_TITLE = "New chat";

/** CAD runtime permanently selected when a conversation is created. */
export type CadEnvironment = "build123d" | "fusion";

export const DEFAULT_CAD_ENVIRONMENT: CadEnvironment = "build123d";

export type FusionReadinessState =
  | "unavailable"
  | "incompatible"
  | "no-document"
  | "wrong-document"
  | "read-only"
  | "busy"
  | "unsupported"
  | "degraded"
  | "ready";

const FUSION_INSPECTABLE_STATES: ReadonlySet<FusionReadinessState> = new Set([
  "read-only",
  "unsupported",
  "degraded",
  "ready",
]);

export function fusionReadinessAllowsInspection(state: FusionReadinessState | undefined): boolean {
  return state !== undefined && FUSION_INSPECTABLE_STATES.has(state);
}

export interface FusionDocumentIdentityDto {
  id: string;
  name: string;
  dataFileId?: string;
  /** Fusion cloud version metadata, present only after persistence when exposed. */
  versionId?: string;
  versionNumber?: number;
}

export type FusionDocumentIdentityKind = "provisional" | "durable";
export type FusionOwnershipRole = "owner" | "read-only";

export interface FusionDocumentBindingDto {
  conversationId: string;
  endpoint: string;
  document: FusionDocumentIdentityDto;
  identityKind: FusionDocumentIdentityKind;
  role: FusionOwnershipRole;
  /** False only when an unsaved document's creation identity has been lost. */
  resumable: boolean;
  boundAt: number;
  updatedAt: number;
}

/** Normalized, browser-safe projection of the server-owned MCP session. */
export interface FusionReadinessDto {
  state: FusionReadinessState;
  label: string;
  diagnosis: string;
  endpoint: string;
  checkedAt: string;
  document?: FusionDocumentIdentityDto;
  /** Fusion's authoritative dirty flag for the active document. */
  documentModified?: boolean;
  /** Camera-restoration integrity verdict from the trusted session; absent until verified. */
  cameraRestored?: boolean;
  /** Conversation-scoped binding and ownership, when a conversation was supplied. */
  binding?: FusionDocumentBindingDto;
  /** True only for a ready owning conversation after the ticket 07 action gate. */
  mutationAllowed: boolean;
  /** Present while an endpoint-wide action is being diagnosed or when a
   * fail-closed recovery condition still blocks lifecycle and mutation work. */
  recovery?: FusionRecoveryDto;
}

export type FusionRecoveryState = "diagnosing" | "hard-recovery" | "resolved";
export type FusionFailureClass =
  | "canceled"
  | "timeout"
  | "disconnect"
  | "transaction-failure"
  | "undo-failure"
  | "revision-uncertain";
export type FusionRecoveryOperation =
  | "wait-for-trusted-inspection"
  | "inspect-resulting-state"
  | "none";

export interface FusionRecoveryDto {
  id: string;
  conversationId: string;
  state: FusionRecoveryState;
  failureClass: FusionFailureClass;
  diagnosis: string;
  allowedOperation: FusionRecoveryOperation;
  precedingRevision: string;
  observedRevision?: string;
  evidenceIds: string[];
  recordedAt: number;
}

export type FusionDocumentationCategory = "class" | "member";
export type FusionDocumentationNamespace = "adsk.core" | "adsk.fusion";

/** Narrow browser request for the installed Fusion API reference. */
export interface FusionDocumentationQueryDto {
  query: string;
  category: FusionDocumentationCategory;
  namespace: FusionDocumentationNamespace;
  /** Fully-qualified owning class, required for member lookup. */
  owner?: string;
}

/** Browser-safe, bounded projection of one installed-documentation lookup. */
export interface FusionDocumentationResultDto {
  query: string;
  excerpts: string[];
  source: {
    kind: "installed-fusion-api";
    fusionVersion: string;
    mcpProtocolVersion: string;
    mcpServer: string;
  };
}

export interface FusionSkillVersionDto {
  name: string;
  version: string;
}

/** Exact reviewed skill versions in force for one persisted Fusion tool record. */
export interface FusionSkillAttributionDto {
  foundation: FusionSkillVersionDto;
  loaded: FusionSkillVersionDto[];
}

export const FusionEvidenceViewSchema = Type.Union([
  Type.Literal("front"), Type.Literal("back"), Type.Literal("left"), Type.Literal("right"),
  Type.Literal("top"), Type.Literal("bottom"), Type.Literal("isometric"), Type.Literal("section"),
]);
export type FusionEvidenceView = Static<typeof FusionEvidenceViewSchema>;

export interface FusionDesignIntentDto {
  designType: string;
  rootComponent: string;
  timelineMarker: number;
}

export interface FusionUnitsDto {
  distance: string;
  angle: string;
  internalDistance: string;
}

export interface FusionParameterDto {
  id: string;
  name: string;
  expression: string;
  valueMm: number;
  /** Native angular value normalized to degrees when this is an angle parameter. */
  valueDegrees?: number;
  unit: string;
}

export interface FusionSketchDto {
  id: string;
  name: string;
  plane: string;
  profiles: number;
  curves: number;
  constraints: string[];
  geometry: Array<{ type: string; data: Record<string, boolean | number | number[] | string> }>;
  constraintDetails: Array<{ type: string; references: string[]; parameter?: string }>;
  dimensionExpressions?: string[];
  /** Native Fusion constraint state, used instead of inferring constraint completeness from counts. */
  fullyConstrained?: boolean;
}

export interface FusionFeatureDto {
  id: string;
  name: string;
  type: string;
  timelineIndex: number;
  suppressed: boolean;
}

export interface FusionFeatureMeasurementDto {
  featureId: string;
  kind: "pocket" | "fillet" | "chamfer" | "bore" | "recess" | "gusset" | "threaded-hole" | "housing-profile" | "circular-pattern";
  centerMm?: [number, number, number];
  diameterMm?: number;
  depthMm?: number;
  radiusMm?: number;
  distanceMm?: number;
  faceCount?: number;
  axis?: "x" | "y" | "z";
  direction?: "positive" | "negative" | "symmetric";
  widthMm?: number;
  heightMm?: number;
  thicknessMm?: number;
  crownRadiusMm?: number;
  pitchMm?: number;
  through?: boolean;
  threadDesignation?: string;
  connectedBodyCount?: number;
  intersectsFeature?: string;
  datumName?: string;
  faceBoundsMm?: Array<{ min: [number, number, number]; max: [number, number, number] }>;
  error?: string;
  occurrenceCount?: number;
}

export interface FusionBodyDto {
  id: string;
  name: string;
  solid: boolean;
  volumeMm3: number;
  boundingBoxMm: [number, number, number];
  material?: string;
  appearance?: string;
  /** Independently read native appearance color, separate from engineering material. */
  appearanceColor?: [number, number, number];
  geometrySignature: {
    faceCount: number;
    edgeCount: number;
    faceAreasMm2: number[];
    edgeLengthsMm: number[];
    boundingBoxMinMm: [number, number, number];
    boundingBoxMaxMm: [number, number, number];
    centerOfMassMm: [number, number, number];
    bodyRevisionId: string;
    surfaceTypes?: string[];
  };
}

export interface FusionMaterialDto {
  id: string;
  name: string;
  /** Native Fusion material-library provenance, when exposed by the API. */
  libraryName?: string;
}

export interface FusionHoleDto {
  featureId: string;
  name?: string;
  centerMm: [number, number, number];
  diameterMm: number;
  through: boolean;
  counterboreDiameterMm?: number;
  counterboreDepthMm?: number;
  direction?: "positive" | "negative";
  normal?: [number, number, number];
}

export interface FusionReferenceDto {
  id: string;
  name: string;
  type: "plane" | "axis" | "point";
  originMm?: [number, number, number];
  normal?: [number, number, number];
}

export type FusionEntityKind = "parameter" | "sketch" | "feature" | "body" | "component";

export interface FusionEntityDto {
  kind: FusionEntityKind;
  id: string;
  name: string;
  nativeToken: string;
  chamferId?: string;
  /** Human-meaningful locator used to diagnose identity changes; never used as
   * the sole mutation address. */
  semanticDescriptor?: string;
}

/** Canonical engineering state. Deliberately contains no viewport or other UI state. */
export interface FusionEngineeringSnapshotDto {
  designIntent: FusionDesignIntentDto;
  units: FusionUnitsDto;
  parameters: FusionParameterDto[];
  sketches: FusionSketchDto[];
  features: FusionFeatureDto[];
  bodies: FusionBodyDto[];
  materials: FusionMaterialDto[];
  /** Native HoleFeature measurements when exposed by the installed Fusion API. */
  holes?: FusionHoleDto[];
  /** Measurements read from native editable features, not inferred from parameters. */
  featureMeasurements?: FusionFeatureMeasurementDto[];
  /** Named native construction geometry used as stable design datums. */
  references?: FusionReferenceDto[];
  entities: FusionEntityDto[];
}

// Fixed-length homogeneous arrays instead of Type.Tuple: TypeBox tuples
// serialize to draft-07 syntax (items: [...] + additionalItems), which strict
// draft-2020-12 tool-schema validators (Anthropic and OpenAI-compatible proxies
// that enforce it) reject with a 400 on the whole legacy Fusion action schema.
// minItems/maxItems arrays are valid across drafts and keep the same wire shape.
// This mirrors the same fix already applied in packages/client planChecks.ts.
const NumberTripleSchema = Type.Array(Type.Number(), { minItems: 3, maxItems: 3 });
const NumberPairSchema = Type.Array(Type.Number(), { minItems: 2, maxItems: 2 });
const RgbTripleSchema = Type.Array(Type.Integer({ minimum: 0, maximum: 255 }), { minItems: 3, maxItems: 3 });

/** One canonical runtime and static contract for bounded action effects. */
export const FusionExpectedEffectSchema = Type.Union([
  Type.Object({ kind: Type.Literal("body-count"), expected: Type.Number() }),
  Type.Object({ kind: Type.Literal("dimensions"), expectedMm: NumberTripleSchema, toleranceMm: Type.Number(), bodyId: Type.Optional(Type.String()) }),
  Type.Union([
    Type.Object({ kind: Type.Literal("volume"), minMm3: Type.Number(), maxMm3: Type.Optional(Type.Number()), bodyId: Type.Optional(Type.String()) }),
    Type.Object({ kind: Type.Literal("volume"), minMm3: Type.Optional(Type.Number()), maxMm3: Type.Number(), bodyId: Type.Optional(Type.String()) }),
  ]),
  Type.Object({ kind: Type.Literal("parameter"), name: Type.String(), expectedMm: Type.Number(), toleranceMm: Type.Number() }),
  Type.Object({ kind: Type.Literal("angle-parameter"), name: Type.String(), expectedDegrees: Type.Number(), toleranceDegrees: Type.Number() }),
  Type.Object({ kind: Type.Literal("fully-constrained-sketches"), minCount: Type.Number(), requireAll: Type.Boolean() }),
  Type.Object({ kind: Type.Literal("circular-pattern"), name: Type.String(), expectedOccurrences: Type.Number() }),
  Type.Object({ kind: Type.Literal("feature"), featureType: Type.String(), name: Type.Optional(Type.String()), minCount: Type.Optional(Type.Number()), maxCount: Type.Optional(Type.Number()), expectedSizeMm: Type.Optional(Type.Number()), toleranceMm: Type.Optional(Type.Number()) }),
  Type.Object({ kind: Type.Literal("material"), expected: Type.String(), acceptedEquivalents: Type.Optional(Type.Array(Type.String())), bodyId: Type.Optional(Type.String()), requireLibraryProvenance: Type.Optional(Type.Boolean()) }),
  Type.Object({ kind: Type.Literal("appearance"), targetRgb: RgbTripleSchema, tolerance: Type.Optional(Type.Number({ minimum: 0 })), bodyId: Type.Optional(Type.String()) }),
  Type.Object({ kind: Type.Literal("thickness"), expectedMm: Type.Number(), toleranceMm: Type.Number(), bodyId: Type.Optional(Type.String()) }),
  Type.Object({ kind: Type.Literal("holes"), expected: Type.Number(), diameterMm: Type.Optional(Type.Number()), edgeOffsetMm: Type.Optional(Type.Number()), through: Type.Optional(Type.Boolean()), toleranceMm: Type.Optional(Type.Number()), bodyId: Type.Optional(Type.String()) }),
  Type.Object({ kind: Type.Literal("hole-pattern"), expected: Type.Number(), diameterMm: Type.Number(), centersMm: Type.Array(NumberTripleSchema), normal: NumberTripleSchema, through: Type.Boolean(), toleranceMm: Type.Number() }),
  Type.Object({ kind: Type.Literal("pocket"), name: Type.String(), diameterMm: Type.Number(), depthMm: Type.Number(), centerMm: NumberPairSchema, toleranceMm: Type.Number() }),
  Type.Object({ kind: Type.Literal("fillet"), name: Type.String(), radiusMm: Type.Number(), faceCount: Type.Number(), placement: Type.Union([Type.Literal("vertical-outer-corners"), Type.Literal("base-vertical-outer-corners")]), toleranceMm: Type.Number() }),
  Type.Object({ kind: Type.Literal("chamfer"), name: Type.String(), distanceMm: Type.Number(), faceCount: Type.Number(), placement: Type.Literal("top-bottom-outer-perimeter"), toleranceMm: Type.Number() }),
  Type.Object({ kind: Type.Literal("named-references"), names: Type.Array(Type.String()), referenceType: Type.Literal("plane"), expectedOriginsMm: Type.Optional(Type.Array(NumberTripleSchema)), expectedNormals: Type.Optional(Type.Array(NumberTripleSchema)), toleranceMm: Type.Optional(Type.Number()) }),
  Type.Object({ kind: Type.Literal("bore"), name: Type.String(), nominalParameter: Type.String(), nominalMm: Type.Number(), minDiameterMm: Type.Number(), maxDiameterMm: Type.Number(), centerMm: NumberTripleSchema, axis: Type.Literal("y"), through: Type.Boolean(), toleranceMm: Type.Number() }),
  Type.Object({ kind: Type.Literal("directional-recess"), name: Type.String(), diameterMm: Type.Number(), depthMm: Type.Number(), datumName: Type.String(), direction: Type.Literal("positive"), through: Type.Literal(false), toleranceMm: Type.Number() }),
  Type.Object({ kind: Type.Literal("counterbored-holes"), expected: Type.Number(), holeDiameterMm: Type.Number(), counterboreDiameterMm: Type.Number(), counterboreDepthMm: Type.Number(), centersMm: Type.Array(NumberTripleSchema), direction: Type.Literal("negative"), toleranceMm: Type.Number() }),
  Type.Object({ kind: Type.Literal("gussets"), expected: Type.Number(), widthMm: Type.Number(), heightMm: Type.Number(), centersXmm: Type.Array(Type.Number()), wallFacesYmm: Type.Array(Type.Number()), connectedBodyCount: Type.Literal(1), toleranceMm: Type.Number() }),
  Type.Object({ kind: Type.Literal("housing-profile"), name: Type.String(), wallWidthMm: Type.Number(), wallThicknessMm: Type.Number(), crownRadiusMm: Type.Number(), axisCenterMm: NumberTripleSchema, toleranceMm: Type.Number() }),
  Type.Object({ kind: Type.Literal("parametric-sketch"), name: Type.String(), requiredExpressions: Type.Array(Type.String()) }),
  Type.Object({ kind: Type.Literal("threaded-hole"), name: Type.String(), diameterMm: Type.Number(), pitchMm: Type.Number(), centerMm: NumberTripleSchema, axis: Type.Literal("z"), direction: Type.Literal("negative"), intersectsFeature: Type.String(), toleranceMm: Type.Number() }),
  Type.Object({ kind: Type.Literal("edge-treatment"), treatment: Type.Union([Type.Literal("fillet"), Type.Literal("chamfer")]), name: Type.String(), sizeMm: Type.Number(), minFaceCount: Type.Number(), placement: Type.Union([Type.Literal("wall-roots"), Type.Literal("gusset-roots"), Type.Literal("bearing-mouths"), Type.Literal("grease-entry"), Type.Literal("base-top-outer-perimeter")]), toleranceMm: Type.Number() }),
  Type.Object({ kind: Type.Literal("visual-evidence"), requiredViews: Type.Optional(Type.Array(FusionEvidenceViewSchema)) }),
]);

export type FusionExpectedEffect = Static<typeof FusionExpectedEffectSchema>;

/** Stable acceptance contract shared by the production-path fake and opt-in live fixture. */
/** Inspections may request experimental checks; unknown kinds are reported unsupported. */
export type FusionCheckInput = FusionExpectedEffect | ({ kind: string } & Record<string, unknown>);

export function isFusionExpectedEffect(value: unknown): value is FusionExpectedEffect {
  return Value.Check(FusionExpectedEffectSchema, value);
}

export interface FusionCheckResultDto {
  kind: string;
  status: "passed" | "failed" | "unsupported";
  detail: string;
  /** The exact caller-requested check this verdict evaluated. Present on every
   * verdict derived from a requested check; absent on server-composed results
   * (structural, intent-preservation, camera-restoration). Callers must match
   * verdicts to their requests by this echo, never by array position. */
  input?: FusionCheckInput;
}

export interface FusionScreenshotDto {
  view: FusionEvidenceView;
  mime: string;
  dataUrl: string;
}

export interface FusionInspectionRecordDto {
  id: string;
  revision: string;
  capturedAt: number;
  stale: boolean;
  staleAt?: number;
  snapshot: FusionEngineeringSnapshotDto;
  checks: FusionCheckResultDto[];
  screenshots: FusionScreenshotDto[];
  cameraRestored: boolean;
}

export type FusionReconciliationStatus = "reconciled" | "needs-user";
export type FusionReconciliationReason =
  | "unambiguous-manual-edit"
  | "ambiguous-entity-identity"
  | "referenced-entity-missing"
  | "active-check-conflict"
  | "structural-edit-needs-user"
  | "unnormalized-revision-change"
  | "unsupported-engineering-state";

export interface FusionEngineeringChangeDto {
  kind: FusionEntityKind | "design" | "material";
  entityId: string;
  name: string;
  change: "added" | "removed" | "modified";
  fields: string[];
}

export interface FusionRefreshedReferenceDto extends FusionAffectedReferenceDto {
  nativeToken: string;
  semanticDescriptor?: string;
}

/** Immutable description of an engineering-state change that happened outside
 * a Chamfer action. It intentionally contains no generated action body. */
export interface FusionReconciliationRecordDto {
  id: string;
  conversationId: string;
  recordedAt: number;
  document: FusionDocumentIdentityDto;
  precedingRevision: string;
  observedRevision: string;
  status: FusionReconciliationStatus;
  reason: FusionReconciliationReason;
  summary: string;
  changes: FusionEngineeringChangeDto[];
  refreshedReferences: FusionRefreshedReferenceDto[];
  refreshedChecks: FusionCheckResultDto[];
  evidenceId: string;
}

export interface FusionInspectionDto {
  document: FusionDocumentIdentityDto;
  readiness: FusionReadinessDto;
  current: FusionInspectionRecordDto;
  history: FusionInspectionRecordDto[];
  /** A revision change invalidates plan decisions and completion claims based on older evidence. */
  earlierActionPlansStale: boolean;
  earlierCompletionEvidenceStale: boolean;
  /** Present when this inspection reconciled a revision not produced by the
   * latest completed Chamfer action. */
  reconciliation?: FusionReconciliationRecordDto;
  /** Present when this inspection rendered views: the revision-bound visual
   * artifact identity, so a read-only visual read can satisfy visual
   * finalization without mutating a finished design. */
  visualArtifact?: { artifactId: string; artifactVersion: number };
}

export type FusionReconciliationPollDto =
  /** Unchanged polls still carry the authoritative revision and any persisted
   * reconciliation for it: an agent-tool inspection may have consumed the
   * revision change first, and the browser must still see that record to
   * cancel stale work and resume from refreshed evidence. */
  | { changed: false; revision?: string; reconciliation?: FusionReconciliationRecordDto }
  | { changed: true; inspection: FusionInspectionDto };

/** Result of the user-authorized lifecycle Save boundary. */
export interface FusionSaveResultDto {
  binding: FusionDocumentBindingDto;
  inspection: FusionInspectionDto;
  evidence: FusionSaveEvidenceDto;
}

/** Immutable evidence captured specifically after an authorized Save. */
export interface FusionSaveEvidenceDto {
  id: string;
  conversationId: string;
  capturedAt: number;
  precedingDocument: FusionDocumentIdentityDto;
  resultingDocument: FusionDocumentIdentityDto;
  revision: string;
  inspection: FusionInspectionRecordDto;
}

export interface FusionAffectedReferenceDto {
  id: string;
  kind: FusionEntityKind;
}

export interface FusionModelIdentityDto {
  provider: string;
  model: string;
}

/** Narrow agent-authored action contract. Model and skill identities are injected
 * by Chamfer's browser tool rather than chosen by the model in its arguments. */
export interface FusionActionRequestDto {
  actionId: string;
  document: FusionDocumentIdentityDto;
  /** Trusted inspection record that supplied expectedRevision; injected by Chamfer. */
  expectedEvidenceId: string;
  expectedRevision: string;
  intent: string;
  strategy: "targeted" | "destructive-rebuild";
  /** Required only for destructive rebuilding. Injected by Chamfer from a
   * persisted user message; it is not part of the model-authored tool schema. */
  destructiveApproval?: {
    basis: "original-replacement-request" | "explicit-approval";
    evidenceMessageId: string;
    expectedRevision: string;
    intent: string;
    statement: string;
  };
  /** Explicit user confirmation for one ambiguous reconciliation occurrence.
   * Injected by Chamfer; excluded from the model-authored tool schema. */
  reconciliationResolution?: {
    reconciliationId: string;
    evidenceMessageId: string;
    expectedRevision: string;
    intent: string;
    affectedReferences: FusionAffectedReferenceDto[];
    statement: string;
  };
  body: string;
  affectedReferences: FusionAffectedReferenceDto[];
  /** Optional self-declared predictions. Verified informationally per action;
   * binding verification happens only at the final plan completion gate. */
  expectedEffects?: FusionExpectedEffect[];
  model: FusionModelIdentityDto;
  skills: FusionSkillAttributionDto;
}

export type FusionActionStatus = "completed" | "rolled-back";
export type FusionActionLedgerEventType = "attempt" | "rejected" | "failed" | "rollback" | "completed";

export interface FusionActionResultDto {
  actionId: string;
  status: FusionActionStatus;
  document: FusionDocumentIdentityDto;
  precedingRevision: string;
  finalRevision: string;
  inspection: FusionInspectionDto;
  /** Checks evaluated against the attempted resulting state. On rollback the
   * inspection's `current` is the restored state, so these are the only
   * record of what the attempt measured. */
  checks: FusionCheckResultDto[];
  undoEntries: number;
  ledgerRecordIds: string[];
  /** Generic deliverable identity used by the cross-environment visual gate. */
  visualArtifact?: { artifactId: string; artifactVersion: number };
}

export interface FusionActionLedgerRecordDto {
  id: string;
  conversationId: string;
  actionId: string;
  event: FusionActionLedgerEventType;
  recordedAt: number;
  document: FusionDocumentIdentityDto;
  expectedRevision: string;
  observedRevision?: string;
  finalRevision?: string;
  model: FusionModelIdentityDto;
  skills: FusionSkillAttributionDto;
  policyVersion: string;
  intent: string;
  bodySha256: string;
  affectedReferences: FusionAffectedReferenceDto[];
  expectedEffects: FusionExpectedEffect[];
  result: Record<string, unknown>;
  evidenceIds: string[];
}

export type FusionCompletionEvidence = Pick<
  FusionActionLedgerRecordDto,
  "event" | "finalRevision" | "result"
>;

/** Canonical rule shared by the display hint and authoritative Save boundary. */
export function fusionCompletionEvidencePassed(evidence: FusionCompletionEvidence | undefined, revision: string): boolean {
  if (!evidence || evidence.event !== "completed" || evidence.finalRevision !== revision || evidence.result.status !== "completed") {
    return false;
  }
  const checks = evidence.result.checks;
  return Array.isArray(checks) && checks.length > 0 && checks.every((check) =>
    typeof check === "object" && check !== null && (check as { status?: unknown }).status === "passed");
}

export interface GenerateTitleDto {
  title: string;
  /** False when generation was skipped (already renamed, or nothing to summarize). */
  generated: boolean;
}

export interface ConversationDto {
  id: string;
  title: string;
  /** Stable design aggregate discussed by this conversation, or null after that design is deleted. */
  designId?: string | null;
  cadEnvironment: CadEnvironment;
  createdAt: number;
  updatedAt: number;
  /** New conversations require durable text specifications before their first plan.
   * Older databases leave this false so pre-feature conversations keep their legacy flow. */
  sourceSpecificationsRequired?: boolean;
  /** Verdict of the most recent verify-gate-bearing run in this conversation. */
  lastGateStatus?: Gate["status"];
  /** Active local-server run, when this conversation is driven headlessly. */
  liveRun?: Pick<HeadlessRunDto, "id" | "status" | "modelName" | "updatedAt">;
}

export type HeadlessRunStatus = "starting" | "running" | "completed" | "stopped" | "crashed";

export interface HeadlessRunDto {
  id: string;
  conversationId: string;
  status: HeadlessRunStatus;
  modelName: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  resumable: boolean;
  lastEventSeq: number;
  error?: string;
}

export type HeadlessRunEvent =
  | { seq: number; type: "run"; run: HeadlessRunDto }
  | { seq: number; type: "session"; state: unknown }
  | { seq: number; type: "mesh"; mesh: { positions: number[]; indices: number[] }; measurements: Measurements }
  | { seq: number; type: "artifact"; artifact: ArtifactDto; gate?: Gate };

export type HeadlessRunEventInput = HeadlessRunEvent extends infer Event
  ? Event extends HeadlessRunEvent
    ? Omit<Event, "seq">
    : never
  : never;

export interface HeadlessRuntimeCapabilitiesDto {
  headlessRuns: boolean;
  /** Whether this deployment can run agent turns. The local server hosts pi
   * agent sessions in-process, so it answers true; the Cloudflare Worker
   * answers true only when a per-user agent container is configured. */
  agentHosting: boolean;
  /** Whether this deployment funds turns for users with no API key of their
   * own: the online demo quota, or a fake-LLM dev stack. Keyless turns then
   * run pinned to `demoModel`; the client gates the composer and labels the
   * status bar with it. */
  demoQuota: boolean;
  /** The model keyless (demo-funded) turns are pinned to; present exactly
   * when demoQuota is true. Its provider feeds the shared funding rule
   * (resolveTurnFunding), where a user key for it makes fallback turns BYOK. */
  demoModel?: { id: string; name: string; provider: Provider };
}

/** This account's lifetime free-demo spend against its cap, in dollars (and the
 * micro-USD source values). Served by the online worker's GET /api/online/budget;
 * absent on the local server, which has no demo quota. `capUsd` is deployment
 * config (not fixed at $2), so the client renders the cap it is told. */
export interface OnlineBudgetDto {
  spentUsd: number;
  capUsd: number;
  spentMicroUsd: number;
  capMicroUsd: number;
}

export interface HeadlessRunImageInput {
  name: string;
  mimeType: string;
  data: string;
}

export interface StartHeadlessRunInput {
  text: string;
  images?: HeadlessRunImageInput[];
}

export interface SteerHeadlessRunInput {
  id: string;
  text: string;
  images?: HeadlessRunImageInput[];
}

export interface DesignProvenanceDto {
  designId: string;
  revision: number;
}

export interface DesignDto {
  id: string;
  name: string;
  description: string;
  cadEnvironment: CadEnvironment;
  /** The latest accepted revision. It does not change while an agent run is in flight. */
  currentRevision: number | null;
  referencedConversationCount: number;
  createdAt: number;
  updatedAt: number;
  /** Fusion document identity remains authoritative and is only mirrored for library display. */
  fusionDocument?: { id: string; name: string };
  provenance?: DesignProvenanceDto;
}

export interface DesignRevisionDto {
  id: string;
  designId: string;
  revision: number;
  pySource: string | null;
  parameters: ParamSpec[];
  gate: Gate;
  measurements: Measurements | null;
  sourceConversationId: string | null;
  sourceArtifactId: string | null;
  /** Authoritative Fusion engineering revision for Fusion-backed history entries. */
  fusionRevision?: string;
  sourceFusionActionId?: string;
  provenance?: DesignProvenanceDto;
  createdAt: number;
}

export interface MessageDto {
  id: string;
  conversationId: string;
  seq: number;
  role: string;
  /** pi AgentMessage serialized verbatim */
  contentJson: string;
  createdAt: number;
}

export interface SourceSpecificationProvenance {
  messageId: string;
  text: string;
  start: number;
  end: number;
}

export interface ReferenceSourceRegion {
  /** Normalized attachment coordinates in the inclusive 0..1 range. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ReferenceSpecificationProvenance {
  attachmentId: string;
  /** What was read from the referenced attachment. */
  observation: string;
  /** The smallest useful source region, when the evidence is spatially localizable. */
  region?: ReferenceSourceRegion;
}

export type DesignSpecificationProvenance =
  | SourceSpecificationProvenance
  | ReferenceSpecificationProvenance;

export interface SourceSpecificationInput {
  /** Stable, conversation-scoped identity. */
  id: string;
  /** A source requirement the design must honor, without a plan check or implementation choice. */
  requirement: string;
  source: DesignSpecificationProvenance;
  /** Active immutable specification replaced by this corrected evidence. */
  supersedesSpecificationId?: string;
  /** Active immutable specifications jointly replaced by one clarifying source answer. */
  supersedesSpecificationIds?: string[];
  /** Active source requirements that cannot all be honored without clarification. */
  conflictsWithSpecificationIds?: string[];
}

export interface RecordSourceSpecificationsInput {
  specifications: SourceSpecificationInput[];
  /** Pending design exception answered by the source message in this mutation. */
  resolvesEscalationId?: string;
}

export interface SourceSpecificationDto extends SourceSpecificationInput {
  conversationId: string;
  actor: "agent" | "migration";
  status: "active" | "superseded";
  supersededBySpecificationId?: string;
  timestamp: number;
}

export type DesignEscalationKind =
  | "conflicting-specifications"
  | "missing-physical-scale"
  | "materially-different-interpretations"
  | "explicit-requirement-change"
  | "verification-check-relaxation";

export interface OpenDesignEscalationInput {
  escalationId: string;
  kind: DesignEscalationKind;
  question: string;
  affectedSpecificationIds: string[];
  basis: string;
  /** The audited held proposal this escalation is allowed to authorize. */
  verificationCheckAttemptId?: string;
}

export interface DesignEscalationDto extends OpenDesignEscalationInput {
  conversationId: string;
  status: "pending" | "resolved";
  openedAt: number;
  resolvedAt?: number;
  resolutionSpecificationIds: string[];
}

/** Durable, conversation-scoped commitments projected into every model turn. */
export interface DurableNoteDto {
  id: string;
  conversationId: string;
  kind: "open-question" | "user-decision";
  text: string;
  status: "active" | "resolved";
  sourceIdentity: string;
  timestamp: number;
}

export type DurableNoteProjection = Omit<DurableNoteDto, "conversationId">;

/** Derives the durable-note compatibility view from authoritative typed state. */
export function deriveDurableNotes(
  sourceSpecifications: readonly Pick<SourceSpecificationDto, "id" | "requirement" | "status" | "timestamp">[],
  designEscalations: readonly Pick<DesignEscalationDto, "escalationId" | "question" | "status" | "openedAt">[],
): DurableNoteProjection[] {
  return [
    ...sourceSpecifications.map((specification): DurableNoteProjection => ({
      id: `decision:${specification.id}`,
      kind: "user-decision",
      text: specification.requirement,
      status: specification.status === "active" ? "active" : "resolved",
      sourceIdentity: specification.id,
      timestamp: specification.timestamp,
    })),
    ...designEscalations.map((escalation): DurableNoteProjection => ({
      id: `question:${escalation.escalationId}`,
      kind: "open-question",
      text: escalation.question,
      status: escalation.status === "pending" ? "active" : "resolved",
      sourceIdentity: escalation.escalationId,
      timestamp: escalation.openedAt,
    })),
  ].sort((left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id));
}

export type ProofContractCriterionCategory =
  | "explicit-requirement"
  | "source-derived-requirement"
  | "conservative-default"
  | "agent-assumption";

export interface ProofContractCriterionDto {
  id: string;
  category: ProofContractCriterionCategory;
  statement: string;
  sourceSpecificationId?: string;
}

export interface ProofContractPlannedCheckDto {
  id: string;
  componentId: string;
  kind: string;
  criterion: Record<string, unknown>;
}

export interface ProofContractUnavailableEvidenceDto {
  id: string;
  requirement: string;
  reason: string;
}

export interface ProofContractDerivationDto {
  planId: string;
  planRevision: number;
  criteriaRevision: number;
  sourceSpecificationIds: string[];
  component: {
    id: string;
    description: string;
    bboxMm?: number[];
  };
  criteria: ProofContractCriterionDto[];
  plannedChecks: ProofContractPlannedCheckDto[];
  unavailableEvidence: ProofContractUnavailableEvidenceDto[];
  invalidatedEvidenceIds: string[];
  proofPolicy: {
    id: string;
    version: number;
  };
  shapeProof:
    | { status: "not-applicable"; reason: string }
    | {
        status: "required" | "unavailable";
        registrations: Array<{
          registrationId: string;
          referenceId: string;
          revision: number;
          eligibility: "eligible" | "advisory";
        }>;
        reason: string;
      };
}

export interface CreateProofContractInput {
  derivation: ProofContractDerivationDto;
  /** Resolved, user-visible exception authorizing this exact relaxation path. */
  relaxationEscalationId?: string;
}

export const TEXT_PROOF_POLICY = {
  id: "proven-single-part-text",
  version: 1,
} as const;

export const REFERENCE_PROOF_POLICY = {
  id: "proven-single-part-reference",
  version: 1,
} as const;

export interface ProofContractDto {
  contractId: string;
  conversationId: string;
  revision: number;
  status: "current" | "stale";
  proofStatus: "pending" | "stale";
  frozenAt: number;
  derivation: ProofContractDerivationDto;
  checkRevision?: {
    comparison: CheckSetComparison;
    authorizedByEscalationId?: string;
    authorizedBySourceSpecificationIds?: string[];
  };
}

export type ProofEvidenceState =
  | "proven"
  | "failed"
  | "unavailable"
  | "not-applicable"
  | "stale";

export interface CreateProofReportInput {
  proofContractId: string;
  proofContractRevision: number;
  planId: string;
  planRevision: number;
  criteriaRevision: number;
  artifactId: string;
  artifactVersion: number;
  engineeringEvidenceId: string;
  /** Required for a reference-backed report once shape proof passes. */
  visualVerificationId?: string;
}

export interface ProofReportPlanDto {
  planId: string;
  revision: number;
  criteriaRevision: number;
  goal: string;
  componentId: string;
  /** Exact accepted operation-backed plan projection at report creation. */
  snapshot: Record<string, unknown>;
}

export interface ProofReportGateDto {
  state: Extract<ProofEvidenceState, "proven" | "failed" | "unavailable">;
  verdict: Gate["status"] | "unavailable";
  checks: GateCheck[];
  checkSet?: { contractId: string; revision: number };
}

export interface ProofReportPlanConformanceDto {
  state: Extract<ProofEvidenceState, "proven" | "failed" | "unavailable">;
  verdict: "passed" | "failed" | "unavailable";
  planId?: string;
  componentCriteriaRevisions: Record<string, number>;
}

export interface ProofReportIntegrityDto {
  state: Extract<ProofEvidenceState, "proven" | "failed" | "unavailable">;
  verdict: ComponentIntegrityMeasurement | null;
}

export interface ProofReportDto {
  reportId: string;
  conversationId: string;
  createdAt: number;
  status: Extract<ProofEvidenceState, "proven" | "failed" | "unavailable" | "stale">;
  proofContract: ProofContractDto;
  acceptedPlan: ProofReportPlanDto;
  sourceSpecifications: SourceSpecificationDto[];
  /** Exact registered source-view records used by reference-backed shape proof. */
  referenceRegistrations: ReferenceRegistrationDto[];
  cadArtifact: {
    id: string;
    version: number;
    createdAt: number;
  };
  engineering: {
    state: Extract<ProofEvidenceState, "proven" | "failed" | "unavailable">;
    evidenceId: string;
    verificationGate: ProofReportGateDto;
    planConformance: ProofReportPlanConformanceDto;
    measurements: Measurements;
  };
  bodyIntegrity: ProofReportIntegrityDto;
  shapeProof:
    | { state: "not-applicable"; reason: string }
    | {
        state: Extract<ProofEvidenceState, "proven" | "failed" | "unavailable">;
        reason: string;
        record: ShapeProofRecord | null;
      };
  visualVerification:
    | { state: "not-applicable"; reason: string }
    | {
        state: Extract<ProofEvidenceState, "proven" | "failed" | "unavailable">;
        reason: string;
        record: VisualVerificationRecordDto | null;
      };
  assumptions: ProofContractCriterionDto[];
  unavailableEvidence: ProofContractUnavailableEvidenceDto[];
}

// ---------- Agent-run lifecycle observability ----------

/** Pillars shared by deterministic benches and production run scoring. */
export const AGENT_EVALUATION_PILLARS = [
  "taskSuccess",
  "gateIntegrity",
  "cost",
  "latency",
  "toolErrorRate",
] as const;
export type AgentEvaluationPillar = typeof AGENT_EVALUATION_PILLARS[number];
export interface AgentEvaluationComparablePillarValues {
  taskSuccess: { passed: boolean | null };
  gateIntegrity: { passed: boolean | null };
  cost: { providerCostUsd: number };
  latency: { totalMs: number };
  toolErrorRate: { errors: number; calls: number; rate: number };
}
export type AgentEvaluationPillars<
  Values extends { [Pillar in AgentEvaluationPillar]: AgentEvaluationComparablePillarValues[Pillar] },
> = { [Pillar in AgentEvaluationPillar]: Values[Pillar] };

/** Artifact-derived configuration identity shared by offline and online evaluation. */
export interface AgentConfigurationIdentity {
  name: string;
  identityHash: string;
}

export function isAgentConfigurationIdentity(value: unknown): value is AgentConfigurationIdentity {
  if (!value || typeof value !== "object") return false;
  const identity = value as Partial<AgentConfigurationIdentity>;
  return typeof identity.name === "string" && identity.name.length > 0 &&
    typeof identity.identityHash === "string" && /^[a-f0-9]{64}$/.test(identity.identityHash);
}

/** Wire contract for browser-owned agent lifecycle events. */
export const AGENT_RUN_LIFECYCLE_VERSION = 1 as const;

export type AgentRunOutcome =
  | "completed"
  | "blocked"
  | "escalated"
  | "failed"
  | "aborted"
  | "incomplete";

export interface AgentConfigurationTraceIdentity extends AgentConfigurationIdentity {
  /** SHA-256 of behavior-affecting configuration inputs. */
  identityHash: string;
  provider: string;
  model: string;
}

export interface AgentRunEvaluationIdentity {
  caseExecutionId: string;
  caseId: string;
  corpusVersion: string;
  repetition: number;
}

/** Browser-query contract for executable, development-only benchmark variants. */
export const AGENT_CONFIGURATION_VARIANT_QUERY_PARAMETER = "chamferAgentConfiguration";
export const BENCH_DETERMINISTIC_TIMING_QUERY_PARAMETER = "chamferBenchDeterministicTiming";
export const DEGRADED_BENCH_CONFIGURATION_MARKER = "[Chamfer degraded bench configuration]";
export const EXECUTABLE_BENCH_CONFIGURATIONS = ["current", "degraded"] as const;
export type ExecutableBenchConfiguration = typeof EXECUTABLE_BENCH_CONFIGURATIONS[number];

interface AgentRunEventBase {
  version: typeof AGENT_RUN_LIFECYCLE_VERSION;
  runId: string;
  seq: number;
  timestamp: number;
}

export interface AgentRunStartedEvent extends AgentRunEventBase {
  type: "run.started";
  agentConfiguration: AgentConfigurationTraceIdentity;
  evaluation?: AgentRunEvaluationIdentity;
}

export interface AgentRunOperationStartedEvent extends AgentRunEventBase {
  type: "turn.started" | "tool.started" | "compaction.started";
  operationId: string;
  /** Present only for tool operations. */
  name?: string;
}

export interface AgentRunOperationCompletedEvent extends AgentRunEventBase {
  type: "turn.completed" | "tool.completed" | "compaction.completed";
  operationId: string;
  outcome: "ok" | "error" | "aborted";
  durationMs: number;
}

export interface AgentRunRetryEvent extends AgentRunEventBase {
  type: "retry.recorded";
  attempt: number;
  delayMs: number;
}

export interface AgentRunPersistenceEvent extends AgentRunEventBase {
  type: "persistence.completed" | "persistence.failed";
  operationId: string;
  durationMs: number;
}

export interface AgentRunCompletedEvent extends AgentRunEventBase {
  type: "run.completed";
  outcome: AgentRunOutcome;
  durationMs: number;
}

export type AgentRunLifecycleEvent =
  | AgentRunStartedEvent
  | AgentRunOperationStartedEvent
  | AgentRunOperationCompletedEvent
  | AgentRunRetryEvent
  | AgentRunPersistenceEvent
  | AgentRunCompletedEvent;

export interface AgentRunLifecycleBatch {
  version: typeof AGENT_RUN_LIFECYCLE_VERSION;
  events: AgentRunLifecycleEvent[];
}

export interface AgentRunCounters {
  modelCalls: number;
  toolCalls: number;
  cadRuns: number;
  retries: number;
  compactions: number;
  persistenceFailures: number;
  searches: number;
  skillLoads: number;
}

export interface AgentRunDurations {
  modelMs: number;
  toolMs: number;
  cadMs: number;
  compactionMs: number;
  persistenceMs: number;
  retryDelayMs: number;
}

export interface AgentRunLifecycleDto {
  version: typeof AGENT_RUN_LIFECYCLE_VERSION;
  id: string;
  conversationId: string;
  status: "running" | "completed";
  outcome?: AgentRunOutcome;
  startedAt: number;
  completedAt?: number;
  totalDurationMs?: number;
  release: string;
  agentConfiguration: AgentConfigurationTraceIdentity;
  evaluation?: AgentRunEvaluationIdentity;
  lastSeq: number;
  counters: AgentRunCounters;
  durations: AgentRunDurations;
}

export type AgentRunFeedbackRating = "positive" | "negative";

export interface AgentRunFeedbackDto {
  rating: AgentRunFeedbackRating;
  createdAt: number;
  syncStatus: "synced" | "unavailable";
}

export interface AttachmentDto {
  id: string;
  messageId: string;
  kind: "user-image" | "view-sheet";
  mime: string;
  contentHash: string;
  byteSize: number;
  displayOrder: number;
}

/** Durable message content block. Pixels are resolved only at UI/model projection boundaries. */
export interface AttachmentReferenceBlock {
  type: "attachment-reference";
  attachmentId: string;
  kind: AttachmentDto["kind"];
  mimeType: string;
}

export type ReferenceClassificationStatus = "active" | "complementary" | "superseded";
export type ReferenceRelationshipType = "complements" | "superseded-by";

export interface ReferenceRelationship {
  type: ReferenceRelationshipType;
  referenceId: string;
}

export interface ClassifyReferenceInput {
  referenceId: string;
  status: ReferenceClassificationStatus;
  purpose: string;
  relationships: ReferenceRelationship[];
  rationale: string;
  /** Durable, conversation-owned design-specification identities. */
  specificationIds?: string[];
  /** @deprecated Accepted only as a compatibility alias for existing clients. */
  specificationLinks?: string[];
  noSpecificationReason?: string;
}

export interface ReferenceClassificationDto extends ClassifyReferenceInput {
  id: string;
  conversationId: string;
  actor: "agent";
  timestamp: number;
  specificationIds: string[];
  /** Compatibility projection of specificationIds for pre-ticket clients. */
  specificationLinks: string[];
  /** Exact pre-migration string locators retained for audit history. */
  legacySpecificationLinks?: string[];
}

export interface ReferenceRecordDto {
  referenceId: string;
  conversationId: string;
  attachmentAvailable: boolean;
  status: "unclassified" | ReferenceClassificationStatus;
  purpose?: string;
  relationships: ReferenceRelationship[];
  rationale?: string;
  specificationIds?: string[];
  /** Compatibility projection of specificationIds for pre-ticket clients. */
  specificationLinks: string[];
  legacySpecificationLinks?: string[];
  noSpecificationReason?: string;
  actor?: ReferenceClassificationDto["actor"];
  timestamp?: number;
  history: ReferenceClassificationDto[];
}

export type ReferenceProjectionKind = "orthographic" | "perspective" | "unknown";
export type ReferenceViewDirection = "front" | "back" | "left" | "right" | "top" | "bottom";

export interface ReferencePoint {
  /** Normalized attachment coordinate in the inclusive 0..1 range. */
  x: number;
  /** Normalized attachment coordinate in the inclusive 0..1 range. */
  y: number;
}

export interface ReferenceScaleAnchor {
  specificationId: string;
  /** Dimension-line endpoints in normalized attachment coordinates. */
  start: ReferencePoint;
  end: ReferencePoint;
  /** The dimension selected from the source specification. */
  physicalLengthMm: number;
}

export interface ReferenceLandmarkProposal {
  id: string;
  label: string;
  position: ReferencePoint;
}

export interface ReferenceRegistrationProposal {
  referenceId: string;
  sourceRegion: ReferenceSourceRegion;
  projection: ReferenceProjectionKind;
  direction?: ReferenceViewDirection;
  scaleAnchor?: ReferenceScaleAnchor;
  visibleLandmarks: ReferenceLandmarkProposal[];
  uncertainty: {
    level: "low" | "medium" | "high";
    notes: string;
    /** True when the source object or its proof-bearing outline is materially occluded. */
    occluded: boolean;
  };
}

export interface ReferenceMaskEvidence {
  width: number;
  height: number;
  /** Alternating background/foreground run lengths, starting with background. */
  rle: number[];
}

export interface ReferenceContourEvidence {
  /** Region-local pixel coordinates in contour order. */
  points: Array<[number, number]>;
  areaPx2: number;
}

export interface ReferenceScaleTransform {
  specificationId: string;
  physicalLengthMm: number;
  pixelLength: number;
  mmPerPixel: number;
}

export interface ReferenceGeometryEvidence {
  sourceSizePx: { width: number; height: number };
  regionPx: { x: number; y: number; width: number; height: number };
  extraction: {
    status: "succeeded" | "failed";
    reason?: string;
    extractor: { id: "opencv-js-contour"; version: number };
  };
  mask?: ReferenceMaskEvidence;
  contour?: ReferenceContourEvidence;
  scaleTransform?: ReferenceScaleTransform;
}

export interface CreateReferenceRegistrationInput extends ReferenceRegistrationProposal {
  /** Geometry derived by product code from the original attachment pixels. */
  geometry: ReferenceGeometryEvidence;
}

export interface ReferenceRegistrationDto extends CreateReferenceRegistrationInput {
  registrationId: string;
  conversationId: string;
  revision: number;
  status: "current" | "stale";
  eligibility: {
    status: "eligible" | "advisory";
    reasons: string[];
  };
  timestamp: number;
}

/** Versioned application policy for independent registered-view proof evaluation.
 * These values are product-owned and never accepted from CAD code or agent tool arguments. */
export const SHAPE_PROOF_POLICY = {
  id: "multi-view-shape-proof",
  version: 1,
  evaluator: { id: "orthographic-mask-and-landmark-comparison", version: 1 },
  minSilhouetteIou: 0.99,
  minContourToleranceMm: 0.15,
  minLandmarkToleranceMm: 0.25,
  sourceResolutionMultiplier: 2,
  evaluationBatchSize: 2,
} as const;

export interface ShapeProofThresholds {
  silhouetteIouMin: number;
  symmetricContourDistanceMmMax: number;
  landmarkPositionErrorMmMax: number;
  sourceResolutionMm: number;
}

export interface ShapeProofLandmarkMetric {
  id: string;
  label: string;
  positionErrorMm?: number;
  status: "passed" | "failed" | "error";
  detail?: string;
}

export interface ShapeProofMetrics {
  silhouetteIou: number;
  symmetricContourDistanceMm: number;
  landmarks: ShapeProofLandmarkMetric[];
}

export type ShapeProofMetricName =
  | "silhouette-iou"
  | "contour-distance"
  | "landmark-position"
  | "evaluation";

export interface ShapeProofViewRecord {
  status: "passed" | "failed" | "error";
  registration: { id: string; revision: number; referenceId: string; direction: ReferenceViewDirection };
  render: { mask?: ReferenceMaskEvidence };
  thresholds: ShapeProofThresholds;
  metrics?: ShapeProofMetrics;
  worst: {
    metric: ShapeProofMetricName;
    landmarkId?: string;
    detail: string;
  };
}

/** Durable proof evidence embedded in the normal CAD tool result.
 * The transcript makes it reload-safe and binds it to immutable contract,
 * registration, artifact, evaluator, and threshold-policy identities. */
export interface ShapeProofRecord {
  status: "passed" | "failed" | "error";
  evaluator: { id: string; version: number };
  policy: { id: string; version: number };
  contract: { id: string; revision: number; criteriaRevision: number };
  coverage: {
    activeReferenceIds: string[];
    requiredRegistrationIds: string[];
    batches: string[][];
  };
  views: ShapeProofViewRecord[];
  /** Compatibility projection of the worst view for existing transcript and UI readers. */
  registration: { id: string; revision: number; referenceId: string; direction: ReferenceViewDirection };
  artifact: { id: string; version: number };
  render: { mask?: ReferenceMaskEvidence };
  thresholds: ShapeProofThresholds;
  metrics?: ShapeProofMetrics;
  worst: {
    metric: ShapeProofMetricName;
    landmarkId?: string;
    detail: string;
  };
}

/** Versioned product policy for controlled render-to-render comparison. */
export const MEASURED_VISUAL_COMPARISON_POLICY = {
  id: "normalized-render-comparison",
  version: 1,
  algorithm: { id: "opencv-silhouette-edge-regions", version: 1 },
  thresholds: {
    silhouetteOverlapMin: 0.995,
    edgeAlignmentMin: 0.97,
  },
  edgeTolerancePx: 1,
  regionGrid: { columns: 4, rows: 4 },
  preprocessing: {
    silhouetteThreshold: 12,
    binaryMaximum: 255,
    morphology: { operation: "open", shape: "ellipse", kernel: { width: 3, height: 3 } },
    blur: { kernel: { width: 3, height: 3 }, sigma: 0 },
    canny: { lowThreshold: 40, highThreshold: 120 },
  },
  controlledRender: {
    tileSizePx: 350,
    columns: 4,
    rows: 2,
    camera: {
      padding: 1.15,
      minimumHalfSize: 1,
      distanceRadiusFactor: 3,
      minimumDistance: 3,
      clipRadiusFactor: 1.5,
      minimumNear: 0.01,
    },
    views: [
      { label: "isometric", direction: [1, -1, 1] },
      { label: "front", direction: [0, -1, 0] },
      { label: "back", direction: [0, 1, 0] },
      { label: "left", direction: [-1, 0, 0] },
      { label: "right", direction: [1, 0, 0] },
      { label: "top", direction: [0, 0, 1], up: [0, 1, 0] },
      { label: "bottom", direction: [0, 0, -1], up: [0, 1, 0] },
    ],
    presentation: {
      panelBackground: "#f1f3f5",
      dimensionsBackground: "#e8ebef",
      labelBackground: "#ffffff",
      textColor: "#20242a",
      faceLightBase: 145,
      faceLightRange: 42,
      faceGreenOffset: 10,
      faceBlueOffset: 24,
    },
  },
} as const;

export type VisualComparisonView =
  | "isometric"
  | "front"
  | "back"
  | "left"
  | "right"
  | "top"
  | "bottom"
  | "section";

export interface VisualDeviationRegion {
  column: number;
  row: number;
  x: number;
  y: number;
  width: number;
  height: number;
  deviation: number;
}

export interface VisualComparisonViewScore {
  view: VisualComparisonView;
  verdict: "match" | "mismatch";
  silhouetteOverlap: number;
  edgeAlignment: number;
  deviation: {
    columns: number;
    rows: number;
    regions: VisualDeviationRegion[];
  };
}

export interface VisualComparisonTargetScore {
  target: {
    kind: "prior-accepted-artifact" | "registered-render";
    id: string;
    artifactId?: string;
    artifactVersion?: number;
    inspectionSheetId?: string;
    referenceId?: string;
  };
  status: "match" | "mismatch" | "unavailable";
  views: VisualComparisonViewScore[];
  reason?: string;
}

/** Durable, machine-originated evidence attached to one rendered CAD result. */
export interface MeasuredVisualComparisonEvidence {
  evidenceId: string;
  /** `not-applicable` is valid only when an initial working candidate has no eligible accepted render baseline. */
  status: "match" | "mismatch" | "unavailable" | "not-applicable";
  policy: { id: string; version: number };
  algorithm: { id: string; version: number };
  thresholds: {
    silhouetteOverlapMin: number;
    edgeAlignmentMin: number;
    edgeTolerancePx: number;
  };
  candidate: {
    artifactId: string;
    artifactVersion: number;
    inspectionSheetId: string;
  };
  comparisons: VisualComparisonTargetScore[];
  reason?: string;
}

export interface InspectEvidenceInput {
  evidenceIds: string[];
  purpose: string;
}

export interface InspectionLeaseEvidenceDto {
  attachmentId: string;
  kind: AttachmentDto["kind"];
  mime: string;
}

export interface InspectionObservationInput {
  relevantViews: string[];
  facts: string[];
  affectedSpecifications: string[];
  affectedComponents: string[];
  noAffectedEntityReason?: string;
}

export interface InspectionObservationDto extends InspectionObservationInput {
  id: string;
  leaseId: string;
  recordedAt: number;
}

export interface InspectionLeaseDto {
  id: string;
  conversationId: string;
  purpose: string;
  status: "open" | "closed";
  evidence: InspectionLeaseEvidenceDto[];
  openedAt: number;
  closedAt?: number;
  observation?: InspectionObservationDto;
}

export type VisualVerificationVerdict = "match" | "needs-revision";

export interface VisualVerificationObservation {
  referenceId: string;
  relevantViews: string[];
  findings: string[];
  affectedComponents: string[];
}

export interface RecordVisualVerificationInput {
  artifactId: string;
  artifactVersion: number;
  inspectionSheetId: string;
  /** Exact measured comparison evidence interpreted by this semantic verdict. */
  visualComparisonEvidenceId: string;
  coveredReferenceIds: string[];
  verdict: VisualVerificationVerdict;
  observations: VisualVerificationObservation[];
}

export interface VisualVerificationRecordDto extends RecordVisualVerificationInput {
  id: string;
  conversationId: string;
  recordedAt: number;
}

export interface RecordVisualVerificationBatchInput {
  artifactId: string;
  artifactVersion: number;
  inspectionSheetId: string;
  /** Exact measured comparison evidence interpreted across every batch. */
  visualComparisonEvidenceId: string;
  imageLimit: number;
  activeReferenceIds: string[];
  batchIndex: number;
  batchCount: number;
  coveredReferenceIds: string[];
  observations: VisualVerificationObservation[];
  finalVerdict?: VisualVerificationVerdict;
  synthesis?: string;
}

export interface VisualVerificationBatchRecordDto extends RecordVisualVerificationBatchInput {
  id: string;
  conversationId: string;
  recordedAt: number;
  finalVerification?: VisualVerificationRecordDto;
}

export interface ArtifactDto {
  id: string;
  conversationId: string;
  version: number;
  pySource: string;
  paramsJson: string | null;
  gate?: Gate;
  measurements?: Measurements;
  createdAt: number;
}

export interface SettingsDto {
  anthropicApiKey?: string;
  anthropicBaseUrl?: string;
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  googleApiKey?: string;
  googleBaseUrl?: string;
  /** Selected model, serialized pi-ai Model JSON */
  modelJson?: string;
  /** Max run_build123d executions per agent turn before the turn is aborted.
   * String-encoded positive integer (settings values are strings on the wire);
   * the client falls back to its built-in default when unset or invalid. */
  maxCadRuns?: string;
  /** Whether chat renders CAD code bodies (tool-call blocks and python fences).
   * "1" shows them; unset or anything else keeps them collapsed to a
   * label-and-actions row. Hidden is the default everywhere. */
  showCadCode?: string;
  /** Strict local endpoint used by the server-owned Autodesk Fusion connector. */
  fusionMcpEndpoint?: string;
}

/** Where an effective settings value came from: the environment (.env /
 * .env.local / real env vars), the settings table, or a stored override
 * shadowing an env value (revertible). */
export type SettingsSource = "env" | "db" | "db-over-env";

export type SettingsSources = Partial<Record<keyof SettingsDto, SettingsSource>>;

/** GET /api/settings payload: effective (env + stored) values plus provenance. */
export interface SettingsResponseDto extends SettingsDto {
  sources: SettingsSources;
  /** Read-only process flag; it is never persisted through PUT /api/settings. */
  experimentalFusionEnabled: boolean;
  /** True for a controlled tester or a release artifact with a complete gate. */
  fusionEnabled: boolean;
  fusionIntegrity: {
    access: "hidden" | "experimental" | "released";
    verdict: "go" | "no-go";
    limitations: string[];
  };
}

/** PUT /api/settings payload: null (or empty string) deletes the stored
 * value, reverting the key to its environment baseline if one exists. */
export type SettingsPatchDto = { [K in keyof SettingsDto]?: string | null };

export interface ModelInfoDto {
  provider: Provider;
  id: string;
  name: string;
  /** Full pi-ai Model object, serialized; passed back verbatim to streamProxy */
  modelJson: string;
}

// ---------- Hosted LLM providers and turn funding (issue #53) ----------

/** Value-level list of the Provider union above: BYOK settings keys, the
 * online LLM proxy routes (/api/llm/<provider>), and the hosted container's
 * egress all quantify over exactly this list. Widen it only together with a
 * proxy route and settings keys for the new provider. */
export const LLM_PROVIDERS: readonly Provider[] = ["anthropic", "openai", "google"];

export function isLlmProvider(value: unknown): value is Provider {
  return (LLM_PROVIDERS as readonly unknown[]).includes(value);
}

/** Display names for provider-facing copy (composer hints, key refusals). */
export const PROVIDER_DISPLAY_NAMES: Record<Provider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
};

/** The provider named by a serialized pi-ai model; undefined when the JSON is
 * absent, unparseable, or names none. */
export function modelJsonProvider(modelJson: string | undefined): string | undefined {
  if (!modelJson) return undefined;
  try {
    const parsed = JSON.parse(modelJson) as { provider?: unknown };
    return typeof parsed.provider === "string" ? parsed.provider : undefined;
  } catch {
    return undefined;
  }
}

/** The per-provider Settings keys a funding decision reads. Values may be the
 * stored secrets or the masked forms GET /api/settings serves - presence
 * (non-empty) is all that matters. */
export type TurnFundingKeys = Pick<SettingsDto, "anthropicApiKey" | "openaiApiKey" | "googleApiKey">;

export interface TurnFundingInputs {
  /** Provider of the user's selected Settings model; undefined when none. */
  selectedProvider: string | undefined;
  keys: TurnFundingKeys;
  /** Provider of the deployment's fallback model (the demo pin, or the
   * fake-LLM model on hermetic stacks); undefined when the deployment cannot
   * fund keyless turns. */
  fallbackProvider: Provider | undefined;
}

/** How the next turn is funded. One rule for every surface that must agree
 * on it - the hosted turn seed (selectTurnModel), server-initiated calls
 * (title generation), and the client's composer gate and status bar - so the
 * surfaces cannot drift (issue #53).
 *
 * kind "run": model "selected" is the user's Settings model on their own
 * key; model "fallback" is the deployment default, funded by the user's own
 * key for the fallback provider when they hold one (the proxy and chat paths
 * resolve keys user-first, so that traffic is BYOK: unpinned, unmetered) and
 * by the demo key only otherwise.
 * kind "blocked": the selected provider is unkeyed and nothing else can
 * fund the turn - the client gates the composer naming missingProvider; the
 * server still delivers the model so an API-driven turn's refusal lands on
 * the transcript.
 * kinds "unroutable" / "no-model": nothing can run at all. */
export type TurnFundingVerdict =
  | { kind: "run"; model: "selected" | "fallback"; funding: "user-key" | "demo" }
  | { kind: "blocked"; missingProvider: Provider }
  | { kind: "unroutable"; provider: string }
  | { kind: "no-model" };

export function resolveTurnFunding(inputs: TurnFundingInputs): TurnFundingVerdict {
  const { selectedProvider, keys, fallbackProvider } = inputs;
  const keyed = (provider: Provider) => Boolean(keys[`${provider}ApiKey`]);
  if (isLlmProvider(selectedProvider) && keyed(selectedProvider)) {
    return { kind: "run", model: "selected", funding: "user-key" };
  }
  if (fallbackProvider) {
    return {
      kind: "run",
      model: "fallback",
      funding: keyed(fallbackProvider) ? "user-key" : "demo",
    };
  }
  if (isLlmProvider(selectedProvider)) {
    return { kind: "blocked", missingProvider: selectedProvider };
  }
  if (selectedProvider) {
    return { kind: "unroutable", provider: selectedProvider };
  }
  return { kind: "no-model" };
}

// ---------- CAD worker protocol ----------

export interface ParamSpec {
  name: string;
  value: number;
  min: number;
  max: number;
  description: string;
}

export interface TopologyCounts {
  faces: number;
  edges: number;
  vertices: number;
  shells: number;
}

/** One detected cylindrical bore. "internal" means material was found past
 * both ends (a buried void); "blind" past exactly one end. */
export interface HoleMeasurement {
  diameterMm: number;
  depthMm: number;
  kind: "through" | "blind" | "internal";
  axisDir: [number, number, number];
  centerMm: [number, number, number];
}

/** Pairwise child clearance: distanceMm for apart/touching,
 * overlapMm3 for interpenetrating. */
export interface ClearanceMeasurement {
  a: string;
  b: string;
  state: "apart" | "touching" | "interpenetrating";
  distanceMm?: number;
  overlapMm3?: number;
}

export type ComponentIntegrityIssueCode =
  | "component-identity"
  | "disconnected-solid"
  | "invalid-topology";

export interface ComponentIntegrityIssue {
  code: ComponentIntegrityIssueCode;
  detail: string;
}

/** Kernel-owned verdict for a run declaring exactly one deliverable component.
 * Omitted for probes, assemblies, and legacy runs without a declaration. */
export interface ComponentIntegrityMeasurement {
  status: "conforming" | "nonconforming";
  componentId: string;
  resultLabel: string;
  solidCount: number;
  valid: boolean;
  issues: ComponentIntegrityIssue[];
}

export interface Measurements {
  bboxMm: [number, number, number];
  volumeMm3: number;
  areaMm2: number;
  children: Array<{ label: string; bboxMm: [number, number, number]; volumeMm3: number }>;
  /** Diagnostics are fail-open: each field is omitted when its evaluator
   * failed, and clearances is only present for multi-child results. */
  topology?: TopologyCounts;
  holes?: HoleMeasurement[];
  clearances?: ClearanceMeasurement[];
  /** Plan evidence echoed verbatim by the harness after a valid declaration. */
  component?: string | string[];
  /** Normalized CAD-code CHECKS retained only for plan-conformance auditing.
   * The kernel gate executes `checks`, which come from the frozen proof contract. */
  submittedChecks?: unknown[];
  checks?: unknown[];
  /** Child labels with no touching or interpenetrating partner. */
  floating?: string[];
  /** Exactly-one-connected-valid-solid and identity verdict for a named part. */
  integrity?: ComponentIntegrityMeasurement;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isBoundingBox(value: unknown): value is [number, number, number] {
  return Array.isArray(value) && value.length === 3 && value.every(isFiniteNumber);
}

/** Runtime contract for the code identity embedded in a rendered CAD result. */
export function isCadCodeIdentity(value: unknown): value is {
  toolCallId: string;
  artifactId?: string;
  artifactVersion?: number;
} {
  if (!isRecord(value) || typeof value.toolCallId !== "string" || value.toolCallId.length === 0) return false;
  if (value.artifactId !== undefined && (typeof value.artifactId !== "string" || value.artifactId.length === 0)) {
    return false;
  }
  return value.artifactVersion === undefined ||
    (Number.isInteger(value.artifactVersion) && (value.artifactVersion as number) >= 0);
}

/** Runtime contract for measurements embedded in a rendered CAD result. */
export function isMeasurements(value: unknown): value is Measurements {
  if (!isRecord(value) || !isBoundingBox(value.bboxMm) ||
      !isFiniteNumber(value.volumeMm3) || !isFiniteNumber(value.areaMm2) || !Array.isArray(value.children)) {
    return false;
  }
  return value.children.every((child) =>
    isRecord(child) && typeof child.label === "string" && isBoundingBox(child.bboxMm) &&
    isFiniteNumber(child.volumeMm3)
  );
}

export interface MeshPayload {
  positions: Float32Array;
  indices: Uint32Array;
}

export type ExportFormat = "step" | "stl" | "3mf" | "py";

export interface GateCheck {
  name: string;
  passed: boolean;
  detail: string;
  /** Stable proof-contract check identity when this is a loop-owned check result. */
  checkId?: string;
}

/** Deterministic verify-gate verdict computed by the harness on every run.
 * "error" means the gate evaluator itself failed (fail-open): the run is
 * still usable, the verdict is not. Optional on the wire so an older worker
 * build never invalidates the response. */
export interface Gate {
  status: "passed" | "failed" | "error";
  checks: GateCheck[];
  checkSet?: { contractId: string; revision: number };
}

export type CadRequest =
  | { id: number; cmd: "run"; code: string; frozenCheckSet?: import("./verificationChecks").FrozenVerificationCheckSet }
  | { id: number; cmd: "parseParams"; code: string }
  | { id: number; cmd: "setParams"; code: string; values: Record<string, number> }
  | { id: number; cmd: "export"; code: string; format: ExportFormat };

export type CadResponse =
  | { id: number; ok: true; cmd: "run"; stdout: string; notices?: string[]; measurements: Measurements; mesh: MeshPayload; gate?: Gate }
  | { id: number; ok: true; cmd: "parseParams"; params: ParamSpec[] }
  | { id: number; ok: true; cmd: "setParams"; code: string }
  | { id: number; ok: true; cmd: "export"; data: Uint8Array; filename: string }
  | { id: number; ok: false; cmd: CadRequest["cmd"]; error: string };

/** Host-neutral CAD execution boundary shared by browser workers and Node runtimes. */
export interface CadExecutor {
  run(
    code: string,
    frozenCheckSet?: import("./verificationChecks").FrozenVerificationCheckSet,
    timeoutMs?: number,
  ): Promise<{ stdout: string; notices?: string[]; measurements: Measurements; mesh: MeshPayload; gate?: Gate }>;
  parseParams(code: string, timeoutMs?: number): Promise<ParamSpec[]>;
  setParams(code: string, values: Record<string, number>, timeoutMs?: number): Promise<string>;
  export(code: string, format: ExportFormat, timeoutMs?: number): Promise<{ data: Uint8Array; filename: string }>;
  dispose(): void | Promise<void>;
}

export type CadBootStatus =
  | { phase: "downloading"; detail: string }
  | { phase: "installing"; detail: string }
  | { phase: "ready" }
  | { phase: "error"; detail: string };

export function isCadResponse(value: unknown): value is CadResponse {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === "number" && typeof v.ok === "boolean" && typeof v.cmd === "string";
}

export * from "./evidence";
export * from "./conversationEvents";
export * from "./verificationChecks";
export * from "./canonicalJson";
