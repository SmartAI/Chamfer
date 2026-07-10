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
}

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

export type CadRequest =
  | { id: number; cmd: "run"; code: string }
  | { id: number; cmd: "parseParams"; code: string }
  | { id: number; cmd: "setParams"; code: string; values: Record<string, number> }
  | { id: number; cmd: "export"; code: string; format: ExportFormat };

export type CadResponse =
  | { id: number; ok: true; cmd: "run"; stdout: string; measurements: Measurements; mesh: MeshPayload }
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
