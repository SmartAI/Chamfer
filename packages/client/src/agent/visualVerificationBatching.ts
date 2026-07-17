import type { VisualVerificationBatchRecordDto } from "@chamfer/shared";
import type { CurrentVisualEvidence } from "./visualVerification";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AttachmentReferenceBlock, RecordVisualVerificationBatchInput, ReferenceRecordDto, VisualVerificationObservation } from "@chamfer/shared";

const FALLBACK_TOTAL_IMAGES = 4;
const ESTIMATED_TOKENS_PER_IMAGE = 2_000;
const IMAGE_CONTEXT_BUDGET_RATIO = 0.5;

export interface VisualBatchModelLimits {
  contextWindow?: number;
  maxInputImages?: number;
}

export interface VisualVerificationBatch {
  batchIndex: number;
  referenceIds: string[];
  imageIds: string[];
}

export interface VisualVerificationBatchPlan extends CurrentVisualEvidence {
  imageLimit: number;
  fullSetRecord: string;
  batches: VisualVerificationBatch[];
  unsupportedReason?: string;
}

export type VisualBatchProgress =
  | { status: "pending"; nextBatchIndex: number; carriedObservations: VisualVerificationBatchRecordDto["observations"] }
  | { status: "complete"; carriedObservations: VisualVerificationBatchRecordDto["observations"] }
  | { status: "invalid"; reason: string; carriedObservations: [] };

/** A turn-end plan is derived after persistence settles and wins one transform race
 * against an older in-memory inspection result that has not been normalized yet. */
export function preferQueuedVisualBatchPlan(
  current: VisualVerificationBatchPlan | undefined,
  queued: VisualVerificationBatchPlan | undefined,
): VisualVerificationBatchPlan | undefined {
  return queued ?? current;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

export function planVisualVerificationBatches(
  evidence: CurrentVisualEvidence,
  limits: VisualBatchModelLimits,
  referenceRecords: readonly ReferenceRecordDto[] = [],
): VisualVerificationBatchPlan {
  const activeReferenceIds = [...new Set(evidence.activeReferenceIds)].sort();
  const contextWindow = positiveInteger(limits.contextWindow) ?? 16_000;
  const contextImageLimit = Math.floor((contextWindow * IMAGE_CONTEXT_BUDGET_RATIO) / ESTIMATED_TOKENS_PER_IMAGE);
  const declaredLimit = positiveInteger(limits.maxInputImages) ?? FALLBACK_TOTAL_IMAGES;
  const imageLimit = Math.min(declaredLimit, contextImageLimit);
  if (imageLimit < 2) {
    return {
      ...evidence,
      activeReferenceIds,
      imageLimit,
      fullSetRecord: compactReferenceRecords(activeReferenceIds, referenceRecords),
      batches: [],
      unsupportedReason: declaredLimit < 2
        ? "The declared provider limit cannot carry the current sheet and one reference (two images)."
        : "The estimated context image budget cannot safely carry the current sheet and one reference.",
    };
  }
  const referencesPerBatch = imageLimit - 1;
  const batches: VisualVerificationBatch[] = [];
  for (let offset = 0; offset < activeReferenceIds.length; offset += referencesPerBatch) {
    const referenceIds = activeReferenceIds.slice(offset, offset + referencesPerBatch);
    batches.push({
      batchIndex: batches.length,
      referenceIds,
      imageIds: [evidence.inspectionSheetId, ...referenceIds],
    });
  }
  return {
    ...evidence,
    activeReferenceIds,
    imageLimit,
    fullSetRecord: compactReferenceRecords(activeReferenceIds, referenceRecords),
    batches,
  };
}

function compactReferenceRecords(ids: readonly string[], records: readonly ReferenceRecordDto[]): string {
  const byId = new Map(records.map((record) => [record.referenceId, record]));
  return ids.map((id) => {
    const record = byId.get(id);
    if (!record) return id;
    const relationships = [...record.relationships]
      .sort((a, b) => `${a.type}:${a.referenceId}`.localeCompare(`${b.type}:${b.referenceId}`))
      .map((item) => `${item.type}:${item.referenceId}`).join("+") || "none";
    return `${id}{status=${record.status};available=${record.attachmentAvailable};purpose=${JSON.stringify(record.purpose ?? "")};relationships=${relationships};specs=${[...(record.specificationIds ?? record.specificationLinks ?? [])].sort().join("+") || "none"};noSpec=${JSON.stringify(record.noSpecificationReason ?? "")}}`;
  }).join("|");
}

export function reconcileVisualVerificationBatches(
  plan: VisualVerificationBatchPlan,
  records: readonly VisualVerificationBatchRecordDto[],
): VisualBatchProgress {
  const relevant = records.filter((record) =>
    record.conversationId === plan.conversationId && record.artifactId === plan.artifactId &&
    record.artifactVersion === plan.artifactVersion && record.inspectionSheetId === plan.inspectionSheetId);
  const observations: VisualVerificationBatchRecordDto["observations"] = [];
  for (let index = 0; index < relevant.length; index += 1) {
    const record = relevant[index]!;
    const expected = plan.batches[index];
    if (record.activeReferenceIds.join(",") !== plan.activeReferenceIds.join(",")) {
      return { status: "invalid", reason: "active reference set changed during verification", carriedObservations: [] };
    }
    if (!expected || record.batchIndex !== index || record.batchCount !== plan.batches.length) {
      return { status: "invalid", reason: "batch sequence is missing, duplicated, or out of order", carriedObservations: [] };
    }
    if (record.coveredReferenceIds.join(",") !== expected.referenceIds.join(",")) {
      return { status: "invalid", reason: "batch coverage does not match the deterministic partition", carriedObservations: [] };
    }
    observations.push(...record.observations);
  }
  return relevant.length === plan.batches.length
    ? { status: "complete", carriedObservations: observations }
    : { status: "pending", nextBatchIndex: relevant.length, carriedObservations: observations };
}

function attachmentReferences(messages: readonly AgentMessage[]): Map<string, AttachmentReferenceBlock> {
  const references = new Map<string, AttachmentReferenceBlock>();
  for (const message of messages) {
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const candidate = block as Partial<AttachmentReferenceBlock>;
      if (candidate.type === "attachment-reference" && typeof candidate.attachmentId === "string" &&
          typeof candidate.mimeType === "string" && (candidate.kind === "user-image" || candidate.kind === "view-sheet")) {
        references.set(candidate.attachmentId, candidate as AttachmentReferenceBlock);
      }
    }
  }
  return references;
}

function compactObservation(observation: VisualVerificationObservation): string {
  return `${observation.referenceId}|views=${observation.relevantViews.join("+")}|findings=${observation.findings.join(" / ")}|components=${observation.affectedComponents.join("+") || "none"}`;
}

/** Adds one deterministic model-only batch request while ensuring its image set is exact. */
export function projectVisualVerificationBatch(
  projected: AgentMessage[],
  durableMessages: readonly AgentMessage[],
  plan: VisualVerificationBatchPlan,
  progress: VisualBatchProgress,
): AgentMessage[] {
  if (progress.status !== "pending" || plan.unsupportedReason) return projected;
  const batch = plan.batches[progress.nextBatchIndex];
  if (!batch) return projected;
  const references = attachmentReferences(durableMessages);
  const selected = batch.imageIds.map((id): AttachmentReferenceBlock | undefined => {
    const existing = references.get(id);
    if (existing) return existing;
    if (id === plan.inspectionSheetId) {
      return { type: "attachment-reference", attachmentId: id, kind: "view-sheet", mimeType: "image/png" };
    }
    if (id !== plan.inspectionSheetId && plan.activeReferenceIds.includes(id)) {
      return { type: "attachment-reference", attachmentId: id, kind: "user-image", mimeType: "image/png" };
    }
    return undefined;
  }).filter((item): item is AttachmentReferenceBlock => Boolean(item));
  if (selected.length !== batch.imageIds.length) return projected;
  const stripped = projected.map((message) => {
    const raw = (message as { content?: unknown }).content;
    if (!Array.isArray(raw)) return message;
    const content = raw.filter((block) => {
      const type = (block as { type?: unknown }).type;
      return type !== "image" && type !== "attachment-reference";
    });
    return content.length === raw.length ? message : { ...message, content } as AgentMessage;
  });
  const carried = progress.carriedObservations.map(compactObservation);
  const final = progress.nextBatchIndex === plan.batches.length - 1;
  return [...stripped, {
    role: "user",
    content: [
      {
        type: "text",
        text: `[Visual verification batch ${progress.nextBatchIndex + 1}/${plan.batches.length}; artifact=${plan.artifactId}@${plan.artifactVersion}; sheet=${plan.inspectionSheetId}; imageLimit=${plan.imageLimit}; activeSet=${plan.fullSetRecord}; batchReferences=${batch.referenceIds.join(",")}; priorObservations=${carried.length > 0 ? carried.join(" || ") : "none"}. Compare only this batch against the shared current sheet. Call record_visual_verification_batch with these exact identities, imageLimit, activeReferenceIds, batchIndex, batchCount, coveredReferenceIds, and one observation per batch reference.${final ? " This is the final batch: include finalVerdict and a non-empty synthesis covering the full carried ledger." : " Do not include a final verdict yet."}]`,
      },
      ...selected,
    ],
    timestamp: 0,
  } as AgentMessage];
}

export function validateProjectedVisualBatchInput(
  plan: VisualVerificationBatchPlan,
  progress: VisualBatchProgress,
  input: RecordVisualVerificationBatchInput,
): string | undefined {
  if (progress.status !== "pending") return "no visual verification batch is currently pending";
  const batch = plan.batches[progress.nextBatchIndex];
  if (!batch || plan.unsupportedReason) return "the current model cannot safely process a visual verification batch";
  if (input.artifactId !== plan.artifactId || input.artifactVersion !== plan.artifactVersion ||
      input.inspectionSheetId !== plan.inspectionSheetId || input.imageLimit !== plan.imageLimit ||
      input.batchIndex !== batch.batchIndex || input.batchCount !== plan.batches.length ||
      input.activeReferenceIds.join(",") !== plan.activeReferenceIds.join(",") ||
      input.coveredReferenceIds.join(",") !== batch.referenceIds.join(",") ||
      input.observations.map((item) => item.referenceId).join(",") !== batch.referenceIds.join(",")) {
    return "batch arguments do not match the exact current model-derived partition";
  }
  const final = batch.batchIndex === plan.batches.length - 1;
  if (final !== Boolean(input.finalVerdict && input.synthesis?.trim())) {
    return final ? "the final batch requires a synthesized verdict" : "only the final batch may include a synthesized verdict";
  }
  return undefined;
}
