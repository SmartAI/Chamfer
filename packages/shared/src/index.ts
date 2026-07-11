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

export interface Measurements {
  bboxMm: [number, number, number];
  volumeMm3: number;
  areaMm2: number;
  children: Array<{ label: string; bboxMm: [number, number, number]; volumeMm3: number }>;
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
