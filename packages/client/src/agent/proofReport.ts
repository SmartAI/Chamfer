import type {
  CreateProofReportInput,
  ProofContractDto,
  ProofReportDto,
  ReferenceRegistrationDto,
  SourceSpecificationDto,
  VisualVerificationRecordDto,
} from "@chamfer/shared";
import { isDomainPlan } from "./domainPlan";
import { latestPlan, type Plan } from "./plan";

interface RunResultRecord {
  role?: unknown;
  toolName?: unknown;
  toolCallId?: unknown;
  details?: {
    code?: { artifactId?: unknown; artifactVersion?: unknown };
    shapeProof?: { status?: unknown };
    inspectionSheet?: { attachmentId?: unknown };
  };
}

function reportInputFromRunIdentity(
  run: RunResultRecord,
  plan: Plan | undefined,
  contract: ProofContractDto | undefined,
  visualVerificationId?: string,
): CreateProofReportInput | undefined {
  if (run?.role !== "toolResult" || run.toolName !== "run_build123d" || typeof run.toolCallId !== "string") {
    return undefined;
  }
  if (!isDomainPlan(plan) || !contract) return undefined;
  const artifactId = run.details?.code?.artifactId;
  const artifactVersion = run.details?.code?.artifactVersion;
  if (typeof artifactId !== "string" || typeof artifactVersion !== "number") return undefined;
  return {
    proofContractId: contract.contractId,
    proofContractRevision: contract.revision,
    planId: plan.domain.plan_id,
    planRevision: plan.domain.revision,
    criteriaRevision: plan.domain.criteria_revision,
    artifactId,
    artifactVersion,
    engineeringEvidenceId: run.toolCallId,
    ...(visualVerificationId ? { visualVerificationId } : {}),
  };
}

export function proofReportInputFromRun(
  message: unknown,
  plan: Plan | undefined,
  contract: ProofContractDto | undefined,
): CreateProofReportInput | undefined {
  const run = message as RunResultRecord;
  return reportInputFromRunIdentity(run, plan, contract);
}

/** Mirrors the server's active-component completeness gate for proven finalization. */
function planComponentsDone(plan: Plan | undefined): boolean {
  const active = (plan?.components ?? []).filter(
    (component) => component.status !== "abandoned" && component.retired_revision === undefined,
  );
  return active.length > 0 && active.every((component) => component.status === "done");
}

/**
 * Produces a report request only at a useful evidence boundary.
 * Text-only parts report directly from their CAD run.
 * Reference-backed parts report a failed shape immediately. A passing shape
 * needs both the matching semantic visual-verification record and the accepted
 * component marked done, so it reports at whichever of those lands last: the
 * verification record, or the plan revision that completes the component.
 */
export function proofReportInputForCurrentEvidence(
  trigger: unknown,
  messages: readonly unknown[],
  plan: Plan | undefined,
  contract: ProofContractDto | undefined,
  visualVerification: VisualVerificationRecordDto | undefined,
): CreateProofReportInput | undefined {
  if (!contract) return undefined;
  if (contract.derivation.shapeProof.status === "not-applicable") {
    return proofReportInputFromRun(trigger, plan, contract);
  }
  const run = [...messages].reverse().find((message) => {
    const candidate = message as RunResultRecord;
    return candidate.role === "toolResult" && candidate.toolName === "run_build123d" &&
      typeof candidate.details?.code?.artifactId === "string" &&
      typeof candidate.details.code.artifactVersion === "number";
  }) as RunResultRecord | undefined;
  if (!run) return undefined;

  const shapeStatus = run.details?.shapeProof?.status;
  const triggerRun = trigger as RunResultRecord;
  if (triggerRun.role === "toolResult" && triggerRun.toolName === "run_build123d" &&
      triggerRun.toolCallId === run.toolCallId && shapeStatus === "failed") {
    return reportInputFromRunIdentity(run, plan, contract);
  }
  const currentArtifactId = run.details?.code?.artifactId;
  const currentArtifactVersion = run.details?.code?.artifactVersion;
  const currentSheetId = run.details?.inspectionSheet?.attachmentId;
  const triggerRecord = trigger as { role?: unknown; toolName?: unknown; isError?: unknown };
  const isVisualBoundary = triggerRecord.role === "toolResult" && triggerRecord.isError !== true &&
    (triggerRecord.toolName === "record_visual_verification" ||
      triggerRecord.toolName === "record_visual_verification_batch");
  // The completion boundary only serves the deferred passed-shape case, and only
  // for the revision that newly completes the plan; anything broader would retry
  // the report under the same evidence idempotency key with a changed revision.
  const triggerToolCallId = (trigger as { toolCallId?: unknown }).toolCallId;
  const priorPlanDone = () => planComponentsDone(latestPlan(messages.filter((message) =>
    (message as { role?: unknown }).role !== "toolResult" ||
    (message as { toolCallId?: unknown }).toolCallId !== triggerToolCallId)));
  const isPlanCompletionBoundary = triggerRecord.role === "toolResult" && triggerRecord.isError !== true &&
    triggerRecord.toolName === "revise_plan" && shapeStatus === "passed" &&
    planComponentsDone(plan) && !priorPlanDone();
  if ((!isVisualBoundary && !isPlanCompletionBoundary) || !visualVerification ||
      visualVerification.artifactId !== currentArtifactId ||
      visualVerification.artifactVersion !== currentArtifactVersion ||
      visualVerification.inspectionSheetId !== currentSheetId) {
    return undefined;
  }
  if (shapeStatus === "passed" && !planComponentsDone(plan)) return undefined;
  return reportInputFromRunIdentity(run, plan, contract, visualVerification.id);
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  const sorted = (values: readonly string[]) => [...values].sort((left, right) => left.localeCompare(right));
  return JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
}

export function effectiveProofReport(
  reports: readonly ProofReportDto[],
  current: {
    plan: Plan | undefined;
    contract: ProofContractDto | undefined;
    sourceSpecifications: readonly SourceSpecificationDto[];
    referenceRegistrations?: readonly ReferenceRegistrationDto[];
    activeReferenceIds?: readonly string[];
    visualVerification?: VisualVerificationRecordDto;
    artifact: { id: string; version: number } | null;
  },
): ProofReportDto | undefined {
  const report = [...reports].sort((a, b) => a.createdAt - b.createdAt).at(-1);
  if (!report || report.status === "stale") return report;
  const activeSpecificationIds = current.sourceSpecifications
    .filter((specification) => specification.status === "active")
    .map((specification) => specification.id);
  const currentRegistrationIds = (current.referenceRegistrations ?? [])
    .filter((registration) => registration.status === "current" &&
      (current.activeReferenceIds ?? []).includes(registration.referenceId))
    .map((registration) => `${registration.registrationId}@${registration.revision}`);
  const reportRegistrationIds = (report.referenceRegistrations ?? [])
    .map((registration) => `${registration.registrationId}@${registration.revision}`);
  const reportReferenceIds = (report.referenceRegistrations ?? [])
    .map((registration) => registration.referenceId);
  const reportVisual = report.visualVerification.state === "not-applicable"
    ? undefined
    : report.visualVerification.record;
  const stale = !isDomainPlan(current.plan) ||
    !current.contract ||
    current.plan.domain.plan_id !== report.acceptedPlan.planId ||
    current.plan.domain.criteria_revision !== report.acceptedPlan.criteriaRevision ||
    current.contract.contractId !== report.proofContract.contractId ||
    current.contract.revision !== report.proofContract.revision ||
    !current.artifact ||
    current.artifact.id !== report.cadArtifact.id ||
    current.artifact.version !== report.cadArtifact.version ||
    !sameIds(activeSpecificationIds, report.sourceSpecifications.map((specification) => specification.id)) ||
    !sameIds(currentRegistrationIds, reportRegistrationIds) ||
    !sameIds(current.activeReferenceIds ?? [], reportReferenceIds) ||
    (report.visualVerification.state !== "not-applicable" &&
      reportVisual === undefined && current.visualVerification !== undefined) ||
    (reportVisual !== undefined && (
      current.visualVerification?.id !== reportVisual?.id ||
      !sameIds(current.activeReferenceIds ?? [], reportVisual?.coveredReferenceIds ?? [])
    ));
  if (!stale) return report;
  return {
    ...report,
    status: "stale",
    proofContract: { ...report.proofContract, status: "stale", proofStatus: "stale" },
  };
}
