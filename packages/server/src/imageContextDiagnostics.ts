import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { AttachmentStorageError, type ImageBlobStore } from "./imageBlobStore";
import { getAttachment } from "./conversationStore";
import { projectEvidence } from "./evidenceStore";

export interface RequestImageDiagnostic {
  hashPrefix: string;
  byteSize: number;
  mimeType: string;
}

export interface ModelRequestDiagnostic {
  sequence: number;
  messageCount: number;
  imageCount: number;
  images: RequestImageDiagnostic[];
  structuredRecords: StructuredBatchDiagnostic[];
  /** Privacy-safe counts proving normalized authority projection without storing prompt text. */
  authoritativePlanProjectionCount?: number;
  sourceSpecificationProjectionCount?: number;
  domainPlanPayloadCount?: number;
}

export interface StructuredBatchDiagnostic {
  batchIndex: number;
  batchCount: number;
  artifactId: string;
  artifactVersion: number;
  inspectionSheetId: string;
  imageLimit: number;
  referenceIds: string[];
  priorObservationCount: number;
}

export interface ImageExposureReport {
  requestCount: number;
  totalImageExposures: number;
  peakImagesPerRequest: number;
  routineRequestCount: number;
  routineImageExposures: number;
  explicitBatchRequestCount: number;
  explicitBatchImageExposures: number;
  uniqueObservedImages: number;
  repeatedPixelsBaselineExposures: number;
  avoidedImageExposures: number;
}

export interface AttachmentLifecycleDiagnostic {
  attachmentId: string;
  kind: string;
  mimeType: string;
  hashPrefix: string;
  byteSize: number;
  lifecycle: string;
  storageState: "available" | "metadata-incomplete" | "missing" | "corrupt" | "unsupported-media" | "path-rejected" | "write-failed";
}

interface ContentBlock {
  type?: unknown;
  text?: unknown;
  data?: unknown;
  mimeType?: unknown;
}

interface DiagnosticMessage {
  content?: unknown;
}

const BATCH_RECORD = /\[Visual verification batch (\d+)\/(\d+); artifact=([^@;\]]+)@(\d+); sheet=([^;\]]+); (?:measuredComparison=[^;\]]+; )?imageLimit=(\d+);[^\]]*?batchReferences=([^;\]]+); priorObservations=(.*?)(?=\. Compare only this batch against the shared current sheet\.|\])[^\]]*\]/g;

function safeIdentity(value: string): string {
  return /^[a-zA-Z0-9_-]+$/.test(value) ? value : "redacted";
}

function batchRecords(text: string): StructuredBatchDiagnostic[] {
  const records: StructuredBatchDiagnostic[] = [];
  for (const match of text.matchAll(BATCH_RECORD)) {
    const observations = match[8]?.trim();
    records.push({
      batchIndex: Number(match[1]),
      batchCount: Number(match[2]),
      artifactId: safeIdentity(match[3] ?? ""),
      artifactVersion: Number(match[4]),
      inspectionSheetId: safeIdentity(match[5] ?? ""),
      imageLimit: Number(match[6]),
      referenceIds: (match[7] ?? "").split(",").map((id) => safeIdentity(id.trim())),
      priorObservationCount: !observations || observations === "none" ? 0 : observations.split("||").length,
    });
  }
  return records;
}

function decodeImage(data: string): Uint8Array {
  const encoded = data.includes(",") ? data.slice(data.indexOf(",") + 1) : data;
  return Buffer.from(encoded, "base64");
}

/** Reduces a model request to non-content-bearing evidence statistics. */
export function sanitizeModelRequest(sequence: number, context: unknown): ModelRequestDiagnostic {
  const messages = (context as { messages?: unknown })?.messages;
  const list = Array.isArray(messages) ? messages as DiagnosticMessage[] : [];
  const images: RequestImageDiagnostic[] = [];
  const structuredRecords: StructuredBatchDiagnostic[] = [];
  let authoritativePlanProjectionCount = 0;
  let sourceSpecificationProjectionCount = 0;
  let domainPlanPayloadCount = 0;
  for (const message of list) {
    if (!Array.isArray(message.content)) continue;
    for (const raw of message.content) {
      const block = raw as ContentBlock;
      if (block.type === "image" && typeof block.data === "string") {
        const bytes = decodeImage(block.data);
        images.push({
          hashPrefix: createHash("sha256").update(bytes).digest("hex").slice(0, 12),
          byteSize: bytes.byteLength,
          mimeType: typeof block.mimeType === "string" ? block.mimeType : "unknown",
        });
      }
      if (block.type === "text" && typeof block.text === "string") {
        structuredRecords.push(...batchRecords(block.text));
        if (block.text === "[Authoritative design plan]") authoritativePlanProjectionCount += 1;
        if (block.text.startsWith("[Current source specifications]")) sourceSpecificationProjectionCount += 1;
        domainPlanPayloadCount += block.text.split('"format":"domain-operations-v1"').length - 1;
      }
    }
  }
  return {
    sequence,
    messageCount: list.length,
    imageCount: images.length,
    images,
    structuredRecords,
    authoritativePlanProjectionCount,
    sourceSpecificationProjectionCount,
    domainPlanPayloadCount,
  };
}

export function summarizeImageExposure(requests: readonly ModelRequestDiagnostic[]): ImageExposureReport {
  const batch = requests.filter((request) => request.structuredRecords.length > 0);
  const batchSequences = new Set(batch.map((request) => request.sequence));
  const routine = requests.filter((request) => !batchSequences.has(request.sequence));
  const uniqueObservedImages = new Set(requests.flatMap((request) => request.images.map((image) => image.hashPrefix))).size;
  const totalImageExposures = requests.reduce((total, request) => total + request.imageCount, 0);
  const firstSeen = new Map<string, number>();
  requests.forEach((request, index) => request.images.forEach((image) => {
    if (!firstSeen.has(image.hashPrefix)) firstSeen.set(image.hashPrefix, index);
  }));
  // Provider-neutral baseline: once pixels first appear, a replay-everything policy
  // would expose them on that request and every remaining request.
  const repeatedPixelsBaselineExposures = [...firstSeen.values()]
    .reduce((total, firstIndex) => total + requests.length - firstIndex, 0);
  return {
    requestCount: requests.length,
    totalImageExposures,
    peakImagesPerRequest: requests.reduce((peak, request) => Math.max(peak, request.imageCount), 0),
    routineRequestCount: routine.length,
    routineImageExposures: routine.reduce((total, request) => total + request.imageCount, 0),
    explicitBatchRequestCount: batch.length,
    explicitBatchImageExposures: batch.reduce((total, request) => total + request.imageCount, 0),
    uniqueObservedImages,
    repeatedPixelsBaselineExposures,
    avoidedImageExposures: Math.max(0, repeatedPixelsBaselineExposures - totalImageExposures),
  };
}

interface AttachmentDiagnosticRow {
  attachment_id: string;
  kind: string;
  mime: string;
  content_hash: string | null;
  byte_size: number | null;
  blob_path: string | null;
  status: string | null;
  active_lease: number;
  sheet_rank: number | null;
}

function lifecycleOf(row: AttachmentDiagnosticRow, currentSheetId: string | undefined): string {
  if (row.active_lease > 0) return "leased-evidence";
  if (row.kind === "view-sheet") return row.attachment_id === currentSheetId ? "current-sheet" : "historical-sheet";
  if (row.status === "active") return "active-reference";
  if (row.status === "complementary") return "complementary-reference";
  if (row.status === "superseded") return "superseded-reference";
  return "unclassified-reference";
}

interface DurableMessage {
  role?: unknown;
  toolName?: unknown;
  isError?: unknown;
  stopReason?: unknown;
  errorMessage?: unknown;
  content?: Array<{ type?: unknown; text?: unknown; kind?: unknown; attachmentId?: unknown }>;
  details?: { inspectionSheet?: { attachmentId?: unknown; gate?: { status?: unknown } } };
}

function isTerminalAssistant(message: DurableMessage): boolean {
  return message.role === "assistant" && !message.errorMessage && message.stopReason !== "toolUse" &&
    Array.isArray(message.content) && !message.content.some((block) => block.type === "toolCall");
}

function isInternalContinuation(message: DurableMessage): boolean {
  return message.role === "user" && Boolean(message.content?.some((block) =>
    block.type === "text" && typeof block.text === "string" && /^\[Chamfer (?:self-check|plan check|visual check)\]/.test(block.text)));
}

function currentSheetId(db: DatabaseSync, conversationId: string): string | undefined {
  const rows = db.prepare("SELECT content_json FROM messages WHERE conversation_id = ? ORDER BY seq ASC")
    .all(conversationId) as Array<{ content_json: string }>;
  const messages = rows.flatMap((row): DurableMessage[] => {
    try { return [JSON.parse(row.content_json) as DurableMessage]; } catch { return []; }
  });
  let sheetIndex = -1;
  let sheetId: string | undefined;
  messages.forEach((message, index) => {
    const candidate = message.details?.inspectionSheet;
    if (message.role === "toolResult" && message.toolName === "run_build123d" && message.isError !== true &&
        candidate?.gate?.status === "passed" && typeof candidate.attachmentId === "string" &&
        message.content?.some((block) => block.type === "attachment-reference" && block.kind === "view-sheet" &&
          block.attachmentId === candidate.attachmentId)) {
      sheetIndex = index;
      sheetId = candidate.attachmentId;
    }
  });
  if (sheetIndex < 0) return undefined;
  let terminalIndex = -1;
  for (let index = sheetIndex + 1; index < messages.length; index += 1) {
    if (isTerminalAssistant(messages[index]!)) terminalIndex = index;
  }
  return terminalIndex < 0 || messages.slice(terminalIndex + 1).some(isInternalContinuation) ? sheetId : undefined;
}

/** Reads only attachment metadata and durable lifecycle relationships. */
export function buildConversationImageDiagnostics(db: DatabaseSync, conversationId: string): {
  conversationId: string;
  attachments: Array<Omit<AttachmentLifecycleDiagnostic, "storageState"> & { metadataComplete: boolean }>;
} {
  const current = currentSheetId(db, conversationId);
  const projection = projectEvidence(db, conversationId);
  const statusByReference = new Map(projection.referenceRecords.map((record) => [record.referenceId, record.status]));
  const leasedEvidenceIds = new Set(projection.inspectionLeases
    .filter((lease) => lease.status === "open")
    .flatMap((lease) => lease.evidence.map((evidence) => evidence.attachmentId)));
  const rows = db.prepare(`
    SELECT a.id AS attachment_id, a.kind, a.mime, a.content_hash, a.byte_size, a.blob_path
    FROM attachments a
    JOIN messages m ON m.id = a.message_id
    WHERE m.conversation_id = ?
    ORDER BY m.seq ASC, a.display_order ASC, a.rowid ASC
  `).all(conversationId) as Array<Omit<AttachmentDiagnosticRow, "status" | "active_lease" | "sheet_rank">>;
  return {
    conversationId,
    attachments: rows.map((stored) => {
      const row: AttachmentDiagnosticRow = {
        ...stored,
        status: statusByReference.get(stored.attachment_id) ?? null,
        active_lease: leasedEvidenceIds.has(stored.attachment_id) ? 1 : 0,
        sheet_rank: null,
      };
      return {
      attachmentId: row.attachment_id,
      kind: row.kind,
      mimeType: row.mime,
      hashPrefix: row.content_hash?.slice(0, 12) ?? "unavailable",
      byteSize: row.byte_size ?? 0,
      lifecycle: lifecycleOf(row, current),
      metadataComplete: Boolean(row.content_hash && row.byte_size !== null && row.blob_path),
      };
    }),
  };
}

export async function verifyConversationImageDiagnostics(
  db: DatabaseSync,
  conversationId: string,
  store: ImageBlobStore,
): Promise<{ conversationId: string; attachments: AttachmentLifecycleDiagnostic[] }> {
  const report = buildConversationImageDiagnostics(db, conversationId);
  return {
    conversationId,
    attachments: await Promise.all(report.attachments.map(async ({ metadataComplete, ...attachment }) => {
      const stored = getAttachment(db, attachment.attachmentId);
      if (!metadataComplete || !stored || stored.storage !== "blob") {
        return { ...attachment, storageState: "metadata-incomplete" as const };
      }
      try {
        await store.read(stored);
        return { ...attachment, storageState: "available" as const };
      } catch (error) {
        const code = error instanceof AttachmentStorageError ? error.code : "corrupt";
        return { ...attachment, storageState: code };
      }
    })),
  };
}
