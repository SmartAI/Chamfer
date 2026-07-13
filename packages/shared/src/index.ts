export const PROXY_AUTH_TOKEN = "chamfer-local";

export type Provider = "anthropic" | "openai" | "google";

/** Title given to a conversation at creation; auto-titling only ever replaces this. */
export const DEFAULT_CONVERSATION_TITLE = "New chat";

export interface GenerateTitleDto {
  title: string;
  /** False when generation was skipped (already renamed, or nothing to summarize). */
  generated: boolean;
}

export interface ConversationDto {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Verdict of the most recent verify-gate-bearing run in this conversation. */
  lastGateStatus?: Gate["status"];
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
  specificationLinks: string[];
  noSpecificationReason?: string;
}

export interface ReferenceClassificationDto extends ClassifyReferenceInput {
  id: string;
  conversationId: string;
  actor: "agent";
  timestamp: number;
}

export interface ReferenceRecordDto {
  referenceId: string;
  conversationId: string;
  attachmentAvailable: boolean;
  status: "unclassified" | ReferenceClassificationStatus;
  purpose?: string;
  relationships: ReferenceRelationship[];
  rationale?: string;
  specificationLinks: string[];
  noSpecificationReason?: string;
  actor?: ReferenceClassificationDto["actor"];
  timestamp?: number;
  history: ReferenceClassificationDto[];
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
}

/** Where an effective settings value came from: the environment (.env /
 * .env.local / real env vars), the settings table, or a stored override
 * shadowing an env value (revertible). */
export type SettingsSource = "env" | "db" | "db-over-env";

export type SettingsSources = Partial<Record<keyof SettingsDto, SettingsSource>>;

/** GET /api/settings payload: effective (env + stored) values plus provenance. */
export interface SettingsResponseDto extends SettingsDto {
  sources: SettingsSources;
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
  checks?: unknown[];
  /** Child labels with no touching or interpenetrating partner. */
  floating?: string[];
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
}

/** Deterministic verify-gate verdict computed by the harness on every run.
 * "error" means the gate evaluator itself failed (fail-open): the run is
 * still usable, the verdict is not. Optional on the wire so an older worker
 * build never invalidates the response. */
export interface Gate {
  status: "passed" | "failed" | "error";
  checks: GateCheck[];
}

export type CadRequest =
  | { id: number; cmd: "run"; code: string }
  | { id: number; cmd: "parseParams"; code: string }
  | { id: number; cmd: "setParams"; code: string; values: Record<string, number> }
  | { id: number; cmd: "export"; code: string; format: ExportFormat };

export type CadResponse =
  | { id: number; ok: true; cmd: "run"; stdout: string; measurements: Measurements; mesh: MeshPayload; gate?: Gate }
  | { id: number; ok: true; cmd: "parseParams"; params: ParamSpec[] }
  | { id: number; ok: true; cmd: "setParams"; code: string }
  | { id: number; ok: true; cmd: "export"; data: Uint8Array; filename: string }
  | { id: number; ok: false; cmd: CadRequest["cmd"]; error: string };

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
