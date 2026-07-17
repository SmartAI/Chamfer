import type { ShapeProofRecord, VisualVerificationRecordDto } from "@chamfer/shared";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ReferenceRecordDto } from "@chamfer/shared";

export interface CurrentVisualEvidence {
  conversationId: string;
  artifactId: string;
  artifactVersion: number;
  inspectionSheetId: string;
  activeReferenceIds: string[];
}

export type VisualFinalizationFailureReason =
  | "missing-verification"
  | "ownership-mismatch"
  | "stale-artifact"
  | "stale-sheet"
  | "incomplete-coverage"
  | "needs-revision";

export type VisualFinalizationResult =
  | { ok: true }
  | { ok: false; reason: VisualFinalizationFailureReason; nudge: string };

interface VisualArtifactIdentity {
  artifactId: string;
  artifactVersion: number;
  inspectionSheetId: string;
}

function latestPassingVisualArtifact(messages: readonly unknown[]): VisualArtifactIdentity | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as {
      role?: unknown;
      toolName?: unknown;
      isError?: unknown;
      details?: {
        code?: { artifactId?: unknown; artifactVersion?: unknown };
        shapeProof?: ShapeProofRecord;
        inspectionSheet?: {
          attachmentId?: unknown;
          code?: { artifactId?: unknown; artifactVersion?: unknown };
          gate?: { status?: unknown };
        };
        status?: unknown;
        visualArtifact?: { artifactId?: unknown; artifactVersion?: unknown; inspectionSheet?: { attachmentId?: unknown } };
      };
    };
    // A read-only rendered visual read at the then-current revision is current
    // evidence when it is the newest visual event: visual finalization of a
    // finished design must be satisfiable without another mutation. Non-visual
    // inspections neither provide nor invalidate evidence.
    if (message.role === "toolResult" && message.toolName === "inspect_fusion") {
      if (message.isError === true) continue;
      const artifact = (message.details as { visualArtifact?: { artifactId?: unknown; artifactVersion?: unknown; inspectionSheet?: { attachmentId?: unknown } } } | undefined)?.visualArtifact;
      if (typeof artifact?.artifactId === "string" && typeof artifact.artifactVersion === "number" && typeof artifact.inspectionSheet?.attachmentId === "string") {
        return { artifactId: artifact.artifactId, artifactVersion: artifact.artifactVersion, inspectionSheetId: artifact.inspectionSheet.attachmentId };
      }
      continue;
    }
    if (message.role === "toolResult" && message.toolName === "run_fusion_action") {
      if (message.isError === true || message.details?.status === "nonconforming") return undefined;
      if (message.details?.status === "rolled-back") continue;
      if (message.details?.status !== "completed") return undefined;
      const artifact = message.details.visualArtifact;
      return typeof artifact?.artifactId === "string" && typeof artifact.artifactVersion === "number" && typeof artifact.inspectionSheet?.attachmentId === "string"
        ? { artifactId: artifact.artifactId, artifactVersion: artifact.artifactVersion, inspectionSheetId: artifact.inspectionSheet.attachmentId }
        : undefined;
    }
    if (message.role !== "toolResult" || message.toolName !== "run_build123d") continue;
    const code = message.details?.code ?? message.details?.inspectionSheet?.code;
    if (typeof code?.artifactId !== "string" || typeof code.artifactVersion !== "number") continue;

    const sheet = message.details?.inspectionSheet;
    if (message.isError === true || sheet?.gate?.status !== "passed" ||
        (message.details?.shapeProof && message.details.shapeProof.status !== "passed") ||
        typeof sheet.attachmentId !== "string" || sheet.code?.artifactId !== code.artifactId ||
        sheet.code.artifactVersion !== code.artifactVersion) {
      return undefined;
    }
    return {
      artifactId: code.artifactId,
      artifactVersion: code.artifactVersion,
      inspectionSheetId: sheet.attachmentId,
    };
  }
  return undefined;
}

export function latestVisualVerification(messages: readonly unknown[]): VisualVerificationRecordDto | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: unknown; toolName?: unknown; isError?: unknown; details?: unknown };
    if (message.role === "toolResult" && message.toolName === "record_visual_verification" &&
        message.isError !== true && typeof message.details === "object" && message.details !== null) {
      return message.details as VisualVerificationRecordDto;
    }
    if (message.role === "toolResult" && message.toolName === "record_visual_verification_batch" &&
        message.isError !== true && typeof message.details === "object" && message.details !== null) {
      const finalVerification = (message.details as { finalVerification?: VisualVerificationRecordDto }).finalVerification;
      if (finalVerification) return finalVerification;
    }
  }
  return undefined;
}

/** The latest verdict only when it still approves the newest deliverable artifact. */
export function currentVisualVerification(
  messages: readonly unknown[],
  references: readonly Pick<ReferenceRecordDto, "referenceId" | "status">[] = [],
): VisualVerificationRecordDto | undefined {
  const identity = latestPassingVisualArtifact(messages);
  const verification = latestVisualVerification(messages);
  if (!identity || !verification) return undefined;
  const activeReferenceIds = references
    .filter((record) => record.status === "active" || record.status === "complementary")
    .map((record) => record.referenceId)
    .sort();
  const coveredReferenceIds = [...verification.coveredReferenceIds].sort();
  const coverageIsCurrent = references.length === 0 ||
    (activeReferenceIds.length === coveredReferenceIds.length &&
      activeReferenceIds.every((id, index) => id === coveredReferenceIds[index]));
  return coverageIsCurrent && verification.artifactId === identity.artifactId &&
    verification.artifactVersion === identity.artifactVersion &&
    verification.inspectionSheetId === identity.inspectionSheetId
    ? verification
    : undefined;
}

export function currentVisualEvidence(
  conversationId: string,
  messages: readonly AgentMessage[],
  references: readonly ReferenceRecordDto[],
): CurrentVisualEvidence | undefined {
  const identity = latestPassingVisualArtifact(messages);
  return identity ? {
    conversationId,
    ...identity,
    activeReferenceIds: references
      .filter((record) => record.status === "active" || record.status === "complementary")
      .map((record) => record.referenceId),
  } : undefined;
}

export function validateVisualFinalization(
  current: CurrentVisualEvidence,
  record: VisualVerificationRecordDto | undefined,
): VisualFinalizationResult {
  if (current.activeReferenceIds.length === 0) return { ok: true };
  if (!record) {
    return {
      ok: false,
      reason: "missing-verification",
      nudge: `Visual finalization is blocked. Record visual verification for artifact ${current.artifactId} version ${current.artifactVersion} and inspection sheet ${current.inspectionSheetId}, covering active references: ${current.activeReferenceIds.join(", ")}.`,
    };
  }

  const uncovered = current.activeReferenceIds.filter((id) =>
    !record.coveredReferenceIds.includes(id) || !record.observations.some((observation) => observation.referenceId === id));
  const ownershipMismatch = record.conversationId !== current.conversationId;
  const staleArtifact = record.artifactId !== current.artifactId || record.artifactVersion !== current.artifactVersion;
  const staleSheet = record.inspectionSheetId !== current.inspectionSheetId;
  const reasons: string[] = [];
  if (ownershipMismatch) reasons.push(`verification belongs to conversation ${record.conversationId}`);
  if (staleArtifact) {
    reasons.push(`artifact ${record.artifactId} version ${record.artifactVersion} is stale; current is ${current.artifactId} version ${current.artifactVersion}`);
  }
  if (staleSheet) reasons.push(`inspection sheet ${record.inspectionSheetId} is stale; current is ${current.inspectionSheetId}`);
  if (uncovered.length > 0) reasons.push(`uncovered references: ${uncovered.join(", ")}`);
  if (record.verdict === "needs-revision") {
    const affected = record.observations.flatMap((observation) => observation.affectedComponents);
    reasons.push(`verdict needs-revision${affected.length > 0 ? ` for components: ${[...new Set(affected)].join(", ")}` : ""}`);
  }

  const reason: VisualFinalizationFailureReason | undefined = ownershipMismatch
    ? "ownership-mismatch"
    : staleArtifact
      ? "stale-artifact"
      : staleSheet
        ? "stale-sheet"
        : uncovered.length > 0
          ? "incomplete-coverage"
          : record.verdict === "needs-revision"
            ? "needs-revision"
            : undefined;
  return reason
    ? { ok: false, reason, nudge: `Visual finalization is blocked: ${reasons.join("; ")}. Inspect the current evidence, revise if needed, then record a current match verdict.` }
    : { ok: true };
}
