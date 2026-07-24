import type { DatabaseSync } from "node:sqlite";
import type {
  RecordVisualVerificationBatchInput,
  RecordVisualVerificationInput,
  VisualVerificationBatchRecordDto,
  VisualVerificationObservation,
  VisualVerificationRecordDto,
} from "@chamfer/shared";
import { listReferenceRecords } from "./referenceClassification";
import { appendEvidenceEvent, projectEvidence } from "./evidenceStore";

export class VisualVerificationError extends Error {
  constructor(message: string, readonly code: "invalid" | "conflict" = "invalid") { super(message); }
}

interface ArtifactRow { id: string; conversation_id: string; version: number; sheetId?: string }
interface MessageRow { content_json: string }
interface VerificationRow {
  id: string;
  conversation_id: string;
  artifact_id: string;
  artifact_version: number;
  inspection_sheet_id: string;
  visual_comparison_evidence_id: string;
  covered_reference_ids_json: string;
  verdict: "match" | "needs-revision";
  observations_json: string;
  recorded_at: number;
}

interface BatchRow {
  id: string;
  conversation_id: string;
  artifact_id: string;
  artifact_version: number;
  inspection_sheet_id: string;
  visual_comparison_evidence_id: string;
  image_limit: number;
  active_reference_ids_json: string;
  batch_index: number;
  batch_count: number;
  covered_reference_ids_json: string;
  observations_json: string;
  final_verdict: "match" | "needs-revision" | null;
  synthesis: string | null;
  recorded_at: number;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function currentSheetId(db: DatabaseSync, conversationId: string, artifact: ArtifactRow): string | undefined {
  const rows = db.prepare("SELECT content_json FROM messages WHERE conversation_id = ? ORDER BY seq DESC")
    .all(conversationId) as unknown as MessageRow[];
  for (const row of rows) {
    try {
      const message = JSON.parse(row.content_json) as {
        role?: unknown;
        toolName?: unknown;
        details?: { inspectionSheet?: { attachmentId?: unknown; code?: { artifactId?: unknown; artifactVersion?: unknown }; gate?: { status?: unknown } } };
      };
      const sheet = message.details?.inspectionSheet;
      if (message.role === "toolResult" && (message.toolName === "run_build123d" || message.toolName === "execute_cad_change") &&
          sheet?.gate?.status === "passed" && sheet.code?.artifactId === artifact.id &&
          sheet.code.artifactVersion === artifact.version && nonEmpty(sheet.attachmentId)) return sheet.attachmentId;
    } catch {
      // Legacy or malformed messages cannot establish current visual evidence.
    }
  }
  return undefined;
}

function currentComparisonEvidenceId(
  db: DatabaseSync,
  conversationId: string,
  artifact: ArtifactRow,
  inspectionSheetId: string,
): string | undefined {
  return [...projectEvidence(db, conversationId).visualComparisons]
    .reverse()
    .find((comparison) =>
      comparison.candidate.artifactId === artifact.id &&
      comparison.candidate.artifactVersion === artifact.version &&
      comparison.candidate.inspectionSheetId === inspectionSheetId)
    ?.evidenceId;
}

function validatedFusionTarget(
  db: DatabaseSync,
  conversationId: string,
  artifactId: string,
  artifactVersion: number,
  sheetId: string,
): ArtifactRow | undefined {
  const inspection = db.prepare("SELECT 1 FROM fusion_inspections WHERE id = ? AND conversation_id = ?")
    .get(artifactId, conversationId);
  const artifact = db.prepare("SELECT id, conversation_id, version FROM artifacts WHERE id = ? AND conversation_id = ? AND version = ?")
    .get(artifactId, conversationId, artifactVersion) as unknown as ArtifactRow | undefined;
  return inspection && artifact ? { ...artifact, sheetId } : undefined;
}

function currentVisualTarget(db: DatabaseSync, conversationId: string): ArtifactRow | undefined {
  const environment = db.prepare("SELECT cad_environment FROM conversations WHERE id = ?").get(conversationId) as { cad_environment?: string } | undefined;
  if (environment?.cad_environment === "fusion") {
    const rows = db.prepare("SELECT content_json FROM messages WHERE conversation_id = ? ORDER BY seq DESC")
      .all(conversationId) as unknown as MessageRow[];
    for (const row of rows) {
      try {
        const message = JSON.parse(row.content_json) as { role?: unknown; toolName?: unknown; isError?: unknown; details?: {
          status?: unknown; visualArtifact?: { artifactId?: unknown; artifactVersion?: unknown; inspectionSheet?: { attachmentId?: unknown } } } };
        const visual = message.details?.visualArtifact;
        if (message.role !== "toolResult") continue;
        // A read-only visual read at the current revision is current evidence;
        // a non-visual inspection neither provides nor invalidates evidence.
        if (message.toolName === "inspect_fusion") {
          if (message.isError === true || !nonEmpty(visual?.artifactId)
            || typeof visual?.artifactVersion !== "number" || !nonEmpty(visual.inspectionSheet?.attachmentId)) continue;
          return validatedFusionTarget(db, conversationId, visual.artifactId, visual.artifactVersion, visual.inspectionSheet.attachmentId);
        }
        if (message.toolName !== "execute_cad_change") continue;
        if (message.isError === true || message.details?.status === "nonconforming") return undefined;
        if (message.details?.status === "rolled-back") continue;
        if (message.details?.status !== "completed") return undefined;
        if (!nonEmpty(visual?.artifactId) || typeof visual?.artifactVersion !== "number" || !nonEmpty(visual.inspectionSheet?.attachmentId)) return undefined;
        return validatedFusionTarget(db, conversationId, visual.artifactId, visual.artifactVersion, visual.inspectionSheet.attachmentId);
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
  const artifact = db.prepare("SELECT id, conversation_id, version FROM artifacts WHERE conversation_id = ? ORDER BY version DESC LIMIT 1")
    .get(conversationId) as unknown as ArtifactRow | undefined;
  if (!artifact) return undefined;
  const sheetId = currentSheetId(db, conversationId, artifact);
  return sheetId ? { ...artifact, sheetId } : undefined;
}

function validateObservations(observations: unknown): observations is VisualVerificationObservation[] {
  return Array.isArray(observations) && observations.every((observation) =>
    typeof observation === "object" && observation !== null &&
    nonEmpty((observation as VisualVerificationObservation).referenceId) &&
    Array.isArray((observation as VisualVerificationObservation).relevantViews) &&
    (observation as VisualVerificationObservation).relevantViews.length > 0 &&
    (observation as VisualVerificationObservation).relevantViews.every(nonEmpty) &&
    Array.isArray((observation as VisualVerificationObservation).findings) &&
    (observation as VisualVerificationObservation).findings.length > 0 &&
    (observation as VisualVerificationObservation).findings.every(nonEmpty) &&
    Array.isArray((observation as VisualVerificationObservation).affectedComponents) &&
    (observation as VisualVerificationObservation).affectedComponents.every(nonEmpty));
}

function toDto(row: VerificationRow): VisualVerificationRecordDto {
  const visualComparisonEvidenceId = row.visual_comparison_evidence_id === "legacy-unmeasured"
    ? `legacy-unmeasured:${row.artifact_id}:${row.artifact_version}:${row.inspection_sheet_id}`
    : row.visual_comparison_evidence_id;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    artifactId: row.artifact_id,
    artifactVersion: row.artifact_version,
    inspectionSheetId: row.inspection_sheet_id,
    visualComparisonEvidenceId,
    coveredReferenceIds: JSON.parse(row.covered_reference_ids_json) as string[],
    verdict: row.verdict,
    observations: JSON.parse(row.observations_json) as VisualVerificationObservation[],
    recordedAt: row.recorded_at,
  };
}

export function listLegacyVisualVerifications(db: DatabaseSync, conversationId: string): VisualVerificationRecordDto[] {
  const rows = db.prepare("SELECT * FROM visual_verifications WHERE conversation_id = ? ORDER BY recorded_at ASC, rowid ASC")
    .all(conversationId) as unknown as VerificationRow[];
  return rows.map(toDto);
}

function batchToDto(row: BatchRow, finalVerification?: VisualVerificationRecordDto): VisualVerificationBatchRecordDto {
  const visualComparisonEvidenceId = row.visual_comparison_evidence_id === "legacy-unmeasured"
    ? `legacy-unmeasured:${row.artifact_id}:${row.artifact_version}:${row.inspection_sheet_id}`
    : row.visual_comparison_evidence_id;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    artifactId: row.artifact_id,
    artifactVersion: row.artifact_version,
    inspectionSheetId: row.inspection_sheet_id,
    visualComparisonEvidenceId,
    imageLimit: row.image_limit,
    activeReferenceIds: JSON.parse(row.active_reference_ids_json) as string[],
    batchIndex: row.batch_index,
    batchCount: row.batch_count,
    coveredReferenceIds: JSON.parse(row.covered_reference_ids_json) as string[],
    observations: JSON.parse(row.observations_json) as VisualVerificationObservation[],
    ...(row.final_verdict ? { finalVerdict: row.final_verdict } : {}),
    ...(row.synthesis ? { synthesis: row.synthesis } : {}),
    recordedAt: row.recorded_at,
    ...(finalVerification ? { finalVerification } : {}),
  };
}

export function listVisualVerifications(db: DatabaseSync, conversationId: string): VisualVerificationRecordDto[] {
  return projectEvidence(db, conversationId).visualVerifications;
}

export function listLegacyVisualVerificationBatches(db: DatabaseSync, conversationId: string): VisualVerificationBatchRecordDto[] {
  const rows = db.prepare(`SELECT * FROM visual_verification_batches
    WHERE conversation_id = ? ORDER BY recorded_at ASC, rowid ASC`).all(conversationId) as unknown as BatchRow[];
  return rows.map((row) => batchToDto(row));
}

export function listVisualVerificationBatches(db: DatabaseSync, conversationId: string): VisualVerificationBatchRecordDto[] {
  return projectEvidence(db, conversationId).visualVerificationBatches;
}

export function recordVisualVerificationBatch(
  db: DatabaseSync,
  conversationId: string,
  input: RecordVisualVerificationBatchInput,
  idempotencyKey?: string,
): VisualVerificationBatchRecordDto {
  if (idempotencyKey) {
    const existing = projectEvidence(db, conversationId).events.find((event) =>
      event.type === "visual-verification-batch.recorded" && event.data.commandIdempotencyKey === idempotencyKey);
    if (existing?.type === "visual-verification-batch.recorded") {
      const batch = existing.data.batch;
      const exact = batch.conversationId === conversationId && batch.artifactId === input.artifactId &&
        batch.artifactVersion === input.artifactVersion && batch.inspectionSheetId === input.inspectionSheetId &&
        batch.visualComparisonEvidenceId === input.visualComparisonEvidenceId &&
        batch.imageLimit === input.imageLimit && JSON.stringify(batch.activeReferenceIds) === JSON.stringify(input.activeReferenceIds) &&
        batch.batchIndex === input.batchIndex && batch.batchCount === input.batchCount &&
        JSON.stringify(batch.coveredReferenceIds) === JSON.stringify(input.coveredReferenceIds) &&
        JSON.stringify(batch.observations) === JSON.stringify(input.observations) &&
        (batch.finalVerdict ?? undefined) === (input.finalVerdict ?? undefined) &&
        (batch.synthesis ?? undefined) === (input.synthesis?.trim() || undefined);
      if (!exact) throw new VisualVerificationError("idempotency key conflicts with an existing visual batch", "conflict");
      return batch;
    }
  }
  const artifact = currentVisualTarget(db, conversationId);
  if (!artifact || artifact.id !== input.artifactId || artifact.version !== input.artifactVersion) {
    throw new VisualVerificationError(`verification must target latest artifact${artifact ? ` ${artifact.id} version ${artifact.version}` : " belonging to this conversation"}`);
  }
  const sheetId = artifact.sheetId;
  if (!sheetId || sheetId !== input.inspectionSheetId) {
    throw new VisualVerificationError(`verification must target current inspection sheet${sheetId ? ` ${sheetId}` : ""}`);
  }
  const comparisonEvidenceId = currentComparisonEvidenceId(db, conversationId, artifact, sheetId);
  if (!comparisonEvidenceId || comparisonEvidenceId !== input.visualComparisonEvidenceId) {
    throw new VisualVerificationError(`verification must cite current measured comparison evidence${comparisonEvidenceId ? ` ${comparisonEvidenceId}` : ""}`);
  }
  const active = listReferenceRecords(db, conversationId)
    .filter((record) => record.status === "active" || record.status === "complementary")
    .map((record) => record.referenceId)
    .sort();
  if (!Array.isArray(input.activeReferenceIds) || input.activeReferenceIds.join(",") !== active.join(",")) {
    throw new VisualVerificationError("active reference set changed or is not in canonical order");
  }
  if (!Number.isInteger(input.batchIndex) || !Number.isInteger(input.batchCount) ||
      !Number.isInteger(input.imageLimit) || input.imageLimit < 2 || input.batchIndex < 0 ||
      input.batchCount < 1 || input.batchIndex >= input.batchCount) {
    throw new VisualVerificationError("invalid visual verification batch position");
  }
  const referencesPerBatch = input.imageLimit - 1;
  const expectedBatchCount = Math.ceil(active.length / referencesPerBatch);
  const expectedCoverage = active.slice(input.batchIndex * referencesPerBatch, (input.batchIndex + 1) * referencesPerBatch);
  if (input.batchCount !== expectedBatchCount || input.coveredReferenceIds.join(",") !== expectedCoverage.join(",")) {
    throw new VisualVerificationError(`coverage does not match deterministic batch ${input.batchIndex}`);
  }
  if (!Array.isArray(input.coveredReferenceIds) || input.coveredReferenceIds.length === 0 ||
      new Set(input.coveredReferenceIds).size !== input.coveredReferenceIds.length || !validateObservations(input.observations)) {
    throw new VisualVerificationError("batch coverage and observations must be structured, unique, and non-empty");
  }
  const observationIds = input.observations.map((item) => item.referenceId);
  if (observationIds.join(",") !== input.coveredReferenceIds.join(",") || input.coveredReferenceIds.some((id) => !active.includes(id))) {
    throw new VisualVerificationError("batch coverage must contain one observation for each active reference in the batch");
  }
    const previous = projectEvidence(db, conversationId).visualVerificationBatches.filter((batch) =>
      batch.artifactId === artifact.id && batch.artifactVersion === artifact.version && batch.inspectionSheetId === sheetId);
    if (input.batchIndex !== previous.length) throw new VisualVerificationError(`expected batch ${previous.length}`);
    if (previous.some((row) => row.batchCount !== input.batchCount || row.imageLimit !== input.imageLimit ||
        JSON.stringify(row.activeReferenceIds) !== JSON.stringify(active) ||
        row.visualComparisonEvidenceId !== comparisonEvidenceId)) {
      throw new VisualVerificationError("batch count, active reference set, or measured comparison changed during verification");
    }
    const alreadyCovered = new Set(previous.flatMap((row) => row.coveredReferenceIds));
    if (input.coveredReferenceIds.some((id) => alreadyCovered.has(id))) {
      throw new VisualVerificationError("batch coverage duplicates an earlier reference");
    }
    const isLast = input.batchIndex === input.batchCount - 1;
    if (!isLast && (input.finalVerdict !== undefined || input.synthesis !== undefined)) {
      throw new VisualVerificationError("final verdict and synthesis are allowed only on the last batch");
    }
    if (isLast && (!input.finalVerdict || !nonEmpty(input.synthesis))) {
      throw new VisualVerificationError("the last batch requires a final verdict and non-empty synthesis");
    }
    const allCovered = [...alreadyCovered, ...input.coveredReferenceIds];
    if (isLast && (allCovered.length !== active.length || active.some((id) => !allCovered.includes(id)))) {
      throw new VisualVerificationError(`final synthesis has missing coverage: ${active.filter((id) => !allCovered.includes(id)).join(", ")}`);
    }

    const batch: VisualVerificationBatchRecordDto = {
      id: idempotencyKey ?? crypto.randomUUID(), conversationId, artifactId: artifact.id,
      artifactVersion: artifact.version, inspectionSheetId: sheetId,
      visualComparisonEvidenceId: comparisonEvidenceId, imageLimit: input.imageLimit,
      activeReferenceIds: active, batchIndex: input.batchIndex, batchCount: input.batchCount,
      coveredReferenceIds: input.coveredReferenceIds, observations: input.observations,
      ...(input.finalVerdict ? { finalVerdict: input.finalVerdict } : {}),
      ...(input.synthesis?.trim() ? { synthesis: input.synthesis.trim() } : {}),
      recordedAt: Date.now(),
    };
    if (isLast) {
      const observations = [...previous.flatMap((item) => item.observations), ...input.observations];
      batch.finalVerification = validatedVisualVerification(db, conversationId, {
        artifactId: artifact.id, artifactVersion: artifact.version, inspectionSheetId: sheetId,
        visualComparisonEvidenceId: comparisonEvidenceId,
        coveredReferenceIds: active, verdict: input.finalVerdict!, observations,
      }, true, idempotencyKey ? `${idempotencyKey}:final` : undefined);
    }
    appendEvidenceEvent(db, conversationId, {
      id: `${conversationId}:visual-verification-batch:${batch.id}`,
      type: "visual-verification-batch.recorded",
      data: { batch, ...(idempotencyKey ? { commandIdempotencyKey: idempotencyKey } : {}) },
    });
    return batch;
}

export function recordVisualVerification(
  db: DatabaseSync,
  conversationId: string,
  input: RecordVisualVerificationInput,
  idempotencyKey?: string,
): VisualVerificationRecordDto {
  const verification = validatedVisualVerification(db, conversationId, input, false, idempotencyKey);
  appendEvidenceEvent(db, conversationId, {
    id: `${conversationId}:visual-verification:${verification.id}`,
    type: "visual-verification.recorded",
    data: { verification, ...(idempotencyKey ? { commandIdempotencyKey: idempotencyKey } : {}) },
  });
  return verification;
}

function validatedVisualVerification(
  db: DatabaseSync,
  conversationId: string,
  input: RecordVisualVerificationInput,
  fromCompletedBatch: boolean,
  idempotencyKey?: string,
): VisualVerificationRecordDto {
  if (idempotencyKey) {
    const existing = projectEvidence(db, conversationId).events.find((event) =>
      event.type === "visual-verification.recorded" && event.data.commandIdempotencyKey === idempotencyKey);
    if (existing?.type === "visual-verification.recorded") {
      const verification = existing.data.verification;
      const exact = verification.conversationId === conversationId && verification.artifactId === input.artifactId &&
        verification.artifactVersion === input.artifactVersion && verification.inspectionSheetId === input.inspectionSheetId &&
        verification.visualComparisonEvidenceId === input.visualComparisonEvidenceId &&
        JSON.stringify(verification.coveredReferenceIds) === JSON.stringify(input.coveredReferenceIds) &&
        verification.verdict === input.verdict && JSON.stringify(verification.observations) === JSON.stringify(input.observations);
      if (exact) return verification;
      throw new VisualVerificationError("idempotency key conflicts with an existing visual verification", "conflict");
    }
  }
  const artifact = currentVisualTarget(db, conversationId);
  if (!artifact) throw new VisualVerificationError(`artifact ${input.artifactId} does not belong to this conversation`);
  if (artifact.id !== input.artifactId || artifact.version !== input.artifactVersion) {
    throw new VisualVerificationError(`verification must target latest artifact ${artifact.id} version ${artifact.version}`);
  }
  const sheetId = artifact.sheetId;
  if (!sheetId || sheetId !== input.inspectionSheetId) {
    throw new VisualVerificationError(`verification must target current inspection sheet${sheetId ? ` ${sheetId}` : ""}`);
  }
  const comparisonEvidenceId = currentComparisonEvidenceId(db, conversationId, artifact, sheetId);
  if (!comparisonEvidenceId || comparisonEvidenceId !== input.visualComparisonEvidenceId) {
    throw new VisualVerificationError(`verification must cite current measured comparison evidence${comparisonEvidenceId ? ` ${comparisonEvidenceId}` : ""}`);
  }
  if (input.verdict !== "match" && input.verdict !== "needs-revision") {
    throw new VisualVerificationError("invalid visual verdict");
  }
  if (!Array.isArray(input.coveredReferenceIds) || input.coveredReferenceIds.some((id) => !nonEmpty(id)) ||
      new Set(input.coveredReferenceIds).size !== input.coveredReferenceIds.length || !validateObservations(input.observations)) {
    throw new VisualVerificationError("coverage and observations must be structured, unique, and non-empty");
  }
  const active = listReferenceRecords(db, conversationId)
    .filter((record) => record.status === "active" || record.status === "complementary")
    .map((record) => record.referenceId);
  if (active.length > 0 && !fromCompletedBatch) {
    throw new VisualVerificationError("active references require the deterministic visual verification batch workflow");
  }
  const observationIds = input.observations.map((observation) => observation.referenceId);
  const uncovered = active.filter((id) => !input.coveredReferenceIds.includes(id) || !observationIds.includes(id));
  const foreign = [...input.coveredReferenceIds, ...observationIds].filter((id) => !active.includes(id));
  if (uncovered.length > 0) throw new VisualVerificationError(`uncovered active references: ${uncovered.join(", ")}`);
  if (foreign.length > 0) throw new VisualVerificationError(`coverage includes inactive or foreign references: ${[...new Set(foreign)].join(", ")}`);
  if (new Set(observationIds).size !== observationIds.length) throw new VisualVerificationError("one observation is required per active reference");
  if (input.verdict === "needs-revision" && !input.observations.some((item) => item.affectedComponents.length > 0)) {
    throw new VisualVerificationError("needs-revision requires an affected component");
  }

  return {
    id: idempotencyKey ?? crypto.randomUUID(), conversationId, artifactId: artifact.id,
    artifactVersion: artifact.version, inspectionSheetId: sheetId,
    visualComparisonEvidenceId: comparisonEvidenceId,
    coveredReferenceIds: input.coveredReferenceIds, verdict: input.verdict,
    observations: input.observations, recordedAt: Date.now(),
  };
}
