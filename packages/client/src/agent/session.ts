import { Agent, streamProxy, type AgentEvent, type AgentMessage, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import type { Model, Api, ImageContent, Message } from "@earendil-works/pi-ai";
import {
  PROXY_AUTH_TOKEN,
  type AttachmentReferenceBlock,
  type CadEnvironment,
  type ReferenceClassificationDto,
  type ReferenceRecordDto,
  type InspectionLeaseDto,
  type VisualVerificationRecordDto,
  type VisualVerificationBatchRecordDto,
  type RecordVisualVerificationBatchInput,
  type FusionActionRequestDto,
  type FusionActionResultDto,
  type SourceSpecificationDto,
  type ProofContractDto,
  type ProofReportDto,
  type DesignEscalationDto,
  type OpenDesignEscalationInput,
  type Measurements,
  type ReferenceRegistrationDto,
  type ShapeProofRecord,
  type AgentRunEvaluationIdentity,
} from "@chamfer/shared";
import * as rest from "../api/rest";
import { transformLlmContext } from "./contextPolicy";
import { runCompaction } from "./compaction";
import { isRetryableFailure, retryDelayMs, withStreamRetry, type StreamRetryOptions } from "./retryStream";
import {
  PROBE_COMPONENT,
  CREATE_PLAN_TOOL_NAME,
  REVISE_PLAN_TOOL_NAME,
  UPDATE_PLAN_TOOL_NAME,
  hasAssemblyEvidence,
  latestPlan,
  parseComponentDeclaration,
  planIncompleteComponents,
  runBudgetBucket,
  validateFusionActionPlan,
  validateRunChecksConformance,
  runComponentIds,
  type PlanConformanceRecord,
} from "./plan";
import { createRetiredUpdatePlanTool, createUpdatePlanTool } from "./tools/updatePlan";
import { createCreatePlanTool, createRevisePlanTool } from "./tools/domainPlan";
import { isDomainPlan, type DomainPlanRevisionBatch } from "./domainPlan";
import { createLoadSkillTool } from "./tools/loadSkill";
import { skillNudgeBlock } from "./skillNudge";
import { DEFAULT_SKILL_MODE, type Build123dSkillMode } from "./build123dSkill";
import { withInspectionSheetEvidence } from "./inspectionSheetLifecycle";
import { fusionSkillAttribution } from "./fusionPrompt";
import { createRunFusionActionTool, destructiveAuthorityFromMessages, reconciliationAuthorityFromMessages } from "./tools/runFusionAction";
import { latestFusionInspectionIdentity } from "./tools/inspectFusion";
import { fusionToolMayBeInjected, projectFusionModelContext } from "./fusionContextPolicy";
import { pendingReferenceIds, projectClassifiedReferences } from "./referenceClassification";
import { createClassifyReferenceTool } from "./tools/classifyReference";
import { createInspectEvidenceTool, createRecordInspectionObservationTool } from "./tools/inspectionEvidence";
import { projectInspectionLeases } from "./inspectionLeaseProjection";
import { createRecordVisualVerificationBatchTool } from "./tools/recordVisualVerificationBatch";
import { currentVisualEvidence, validateVisualFinalization } from "./visualVerification";
import { planVisualVerificationBatches, preferQueuedVisualBatchPlan, projectVisualVerificationBatch, reconcileVisualVerificationBatches, validateProjectedVisualBatchInput, type VisualVerificationBatchPlan } from "./visualVerificationBatching";
import { createRecordSourceSpecificationsTool, sourceTextOf } from "./tools/recordSourceSpecifications";
import { createRecordReferenceSpecificationsTool } from "./tools/recordReferenceSpecifications";
import { createRegisterReferenceViewTool } from "./tools/registerReferenceView";
import { projectSourceSpecifications } from "./sourceSpecifications";
import {
  projectReferenceRegistrations,
  referenceRegistrationGateError,
  unregisteredReferenceIds,
} from "./referenceRegistrations";
import { projectAuthoritativePlan } from "./authoritativePlanProjection";
import {
  currentProofContract,
  deriveProofContract,
  isProbeCadCode,
  proofContractPreflightError,
  proofRunIdentityErrors,
} from "./proofContract";
import { createRequestDesignClarificationTool } from "./tools/requestDesignClarification";
import {
  designActionEscalationError,
  explicitRequirementWeakeningReasons,
  projectDesignEscalations,
  validateDesignEscalationRequest,
} from "./escalationPolicy";
import { proofReportInputForCurrentEvidence } from "./proofReport";
import { evaluateMultiViewShapeProof, shapeProofErrorRecord } from "./shapeProof";
import type { RunBuild123dDetails } from "./tools/runBuild123d";
import { AgentRunReporter, createAgentConfigurationTraceIdentity } from "./agentRunLifecycle";

export interface ChatSession {
  conversationId: string;
  /**
   * Runs one agent.prompt() turn. `images` are embedded in the pi user message as image
   * content blocks (after the text block) and also uploaded as `user-image` attachments
   * tied to the persisted user message.
   */
  send(text: string, images?: File[]): Promise<void>;
  /**
   * Queues a user correction into the active pi run. The promise settles after pi
   * consumes and persists that exact message at the next turn boundary.
   */
  steer(id: string, text: string, images?: File[]): Promise<"consumed" | "cancelled">;
  cancelSteering(id: string): void;
  prioritizeSteering(id: string): void;
  abort(): void;
  subscribe(listener: (state: SessionState) => void): () => void;
}

export type SessionErrorKind = "invalid-key" | "rate-limited" | "context-overflow" | "generic";

export interface SessionError {
  kind: SessionErrorKind;
  message: string;
}

/** Transient activity the status strip shows while the session works around provider limits. */
export type SessionNotice =
  | { kind: "retrying"; attempt: number; maxAttempts: number; delaySeconds: number }
  | { kind: "compacting" };

export interface SessionState {
  /** pi AgentMessages: persisted history plus the live streaming partial, if any. */
  messages: unknown[];
  /** Current durable reference classifications used by visual-status surfaces. */
  referenceRecords?: ReferenceRecordDto[];
  /** Current immutable source requirements, rendered and projected separately from the plan. */
  sourceSpecifications?: SourceSpecificationDto[];
  /** Durable autonomous proof-contract history for the current single-part plan. */
  proofContracts?: ProofContractDto[];
  /** Durable version-bound proof reports derived from CAD and domain records. */
  proofReports?: ProofReportDto[];
  /** Durable exception history and the one focused pending question, if any. */
  designEscalations?: DesignEscalationDto[];
  /** Durable reference-view registration history and current eligibility. */
  referenceRegistrations?: ReferenceRegistrationDto[];
  streaming: boolean;
  error?: SessionError;
  notice?: SessionNotice;
}

// Provider/proxy failure text is free-form (streamProxy wraps HTTP failures as
// "Proxy error: <status> ...", providers embed their own JSON error strings), so
// classification is a best-effort text match. Anything unrecognized stays "generic",
// which renders as a plain banner; misclassification therefore only changes which
// recovery affordance is offered, never hides the message.
const INVALID_KEY_PATTERN =
  /\b401\b|unauthorized|invalid[^.]{0,20}(api[ _-]?key|x-api-key)|authentication|api key|credit|billing/i;
const RATE_LIMIT_PATTERN = /\b429\b|rate[ _-]?limit|too many requests/i;
// Provider phrasings observed for a request larger than the model window:
// OpenAI "Your input exceeds the context window of this model" / "maximum context
// length is N tokens", Anthropic "prompt is too long: N tokens > M maximum".
const CONTEXT_OVERFLOW_PATTERN =
  /context window|context[ _-]?length|prompt is too long|input.{0,40}exceeds|too many total text bytes/i;

/** Maps a raw failure message to a SessionError {kind, message}. */
export function classifySessionError(message: string): SessionError {
  if (CONTEXT_OVERFLOW_PATTERN.test(message)) return { kind: "context-overflow", message };
  if (INVALID_KEY_PATTERN.test(message)) return { kind: "invalid-key", message };
  if (RATE_LIMIT_PATTERN.test(message)) return { kind: "rate-limited", message };
  return { kind: "generic", message };
}

/** Whether an errored run should resume by itself. Auth failures repeat identically
 * and need the user; rate limits and transport/server faults recover with time.
 * Context overflow is not retryable as-is - the continuation loop handles it by
 * compacting first, through its own bounded branch. */
export function isResumableSessionError(error: SessionError): boolean {
  if (error.kind === "invalid-key" || error.kind === "context-overflow") return false;
  return error.kind === "rate-limited" || isRetryableFailure(error.message);
}

export interface CreateSessionOptions {
  conversationId: string;
  /** Immutable CAD environment bound to the persisted conversation. */
  cadEnvironment?: CadEnvironment;
  modelJson: string;
  systemPrompt: string;
  /** AgentTool[]; empty in M2, filled in M4. */
  tools?: unknown[];
  /** Build123d skill treatment; load_skill is registered unless the ablation arm
   * ("none"/"core") predates the skill layer. Defaults to DEFAULT_SKILL_MODE. */
  skillMode?: Build123dSkillMode;
  /** Replayed from REST: parsed AgentMessage history for this conversation. */
  priorMessages: unknown[];
  /** First client-owned sequence available after the durable history loaded from REST. */
  nextMessageSeq?: number;
  /** Durable current reference state and append-only history loaded with the conversation. */
  referenceRecords?: ReferenceRecordDto[];
  /** Durable text- and reference-source requirements loaded with the conversation. */
  sourceSpecifications?: SourceSpecificationDto[];
  /** Durable autonomous proof-contract revisions loaded with the conversation. */
  proofContracts?: ProofContractDto[];
  /** Durable proof-report history loaded with the conversation. */
  proofReports?: ProofReportDto[];
  /** Durable exception-based escalation history loaded with the conversation. */
  designEscalations?: DesignEscalationDto[];
  /** Durable reference-view registration revisions loaded with the conversation. */
  referenceRegistrations?: ReferenceRegistrationDto[];
  /** True for post-migration conversations; false preserves the legacy no-specification path. */
  sourceSpecificationsRequired?: boolean;
  /** Durable leases that were still open when the conversation was loaded. */
  openInspectionLeases?: InspectionLeaseDto[];
  /** Durable visual verdict history loaded with the conversation. */
  visualVerifications?: VisualVerificationRecordDto[];
  /** Durable partial visual batch ledger loaded with the conversation. */
  visualVerificationBatches?: VisualVerificationBatchRecordDto[];
  /** Max run_build123d executions per turn before the turn is aborted;
   * defaults to DEFAULT_MAX_CAD_RUNS. Configurable via settings/env. */
  maxCadRuns?: number;
  /** Same-origin Chamfer action endpoint. Raw Autodesk tools are never agent tools. */
  executeFusionAction?: (input: FusionActionRequestDto, signal?: AbortSignal) => Promise<FusionActionResultDto>;
  /** Optional pinned evaluation execution identity for controlled browser runs. */
  evaluationIdentity?: AgentRunEvaluationIdentity;
  /**
   * Internal test-only override for the stream function. Production callers must not set this;
   * it exists so tests can inject a fake streamFn without mocking the whole pi-agent-core module.
   */
  __streamFn?: StreamFn;
  /**
   * Internal test-only override for retry pacing (sleep, attempt budget, delays). Production
   * callers must not set this; the session always installs its own onWait/onResume callbacks.
   */
  __retryOptions?: Pick<StreamRetryOptions, "sleep" | "maxAttempts" | "baseDelayMs" | "maxDelayMs">;
  /** Internal test-only override for autonomous-continuation pacing and budgets. */
  __autoResumeOptions?: {
    sleep?: (ms: number) => Promise<void>;
    maxErrorResumes?: number;
    maxBudgetContinues?: number;
    maxOverflowCompactions?: number;
  };
  /** Test/evidence hook recording the images selected at each model boundary. */
  __onImageExposure?: (trace: ImageExposureTrace) => void;
}

export interface ImageExposureTrace {
  totalImages: number;
  currentSheetImages: number;
  currentSheetAttachmentIds: string[];
}

function buildStreamFn(conversationId: string): StreamFn {
  return (model, context, options) =>
    streamProxy(model, context, {
      ...options,
      sessionId: conversationId,
      authToken: PROXY_AUTH_TOKEN,
      proxyUrl: window.location.origin,
    });
}

const PERSIST_RETRY_DELAY_MS = 250;
export const DEFAULT_MAX_CAD_RUNS = 10;

// Autonomous continuation budgets. The session keeps a send() alive by itself -
// resuming after transient provider failures and renewing per-turn CAD budgets -
// until the plan completes, a genuine limitation is confirmed, budget windows stop
// making progress, or the user aborts. Sized so an overnight build survives a
// multi-minute provider outage and a complex part (30+ feature actions), while a
// stuck loop still terminates deterministically.
export const MAX_ERROR_RESUMES = 6;
const ERROR_RESUME_BASE_DELAY_MS = 5_000;
const ERROR_RESUME_MAX_DELAY_MS = 300_000;
export const MAX_BUDGET_CONTINUES = 8;
export const MAX_PLAN_NUDGES_WITHOUT_RUN = 3;
/** Context-overflow recoveries per send: each successful compaction frees a large
 * window, so needing more than a few in one send means summaries are not shrinking
 * the context and the failure must surface to the user. */
export const MAX_OVERFLOW_COMPACTIONS = 3;

/** Prefix identifying the injected self-check nudge, so the UI can render it as a
 * system chip and the rate-limit Retry action never resends it as the user's prompt. */
export const SELF_CHECK_MARKER = "[Chamfer self-check]";

export const SELF_CHECK_PROMPT = `${SELF_CHECK_MARKER} The verify gate passed for the current script. A passing gate only confirms the current geometry matches its own EXPECT block - it does not mean the whole request is done. For an image request, compare the latest inspection sheet against the reference image view by view: isometric, front, back, left, right, top, and bottom. Record a match or mismatch verdict and a concrete note for every view in form_review, tied by evidence_id to that latest gate-passed run. Fix any mismatch before marking the component done. For a text-only request, re-read the original request and check every requested part, feature, and step against the latest measurements and views. If anything is missing, continue building it now. If everything is satisfied, reply with the final summary.`;

/** Prefix identifying the deterministic plan stop-gate nudge (planned turns replace
 * the prose self-check with this; the UI renders it as a system chip). */
export const PLAN_NUDGE_MARKER = "[Chamfer plan check]";
export const VISUAL_NUDGE_MARKER = "[Chamfer visual check]";
export const FUSION_RECONCILIATION_MARKER = "[Chamfer Fusion reconciliation]";

/** With an active plan, the per-turn ceiling is this multiple of maxCadRuns; each
 * component bucket individually stays within maxCadRuns. */
export const PLAN_BUDGET_CEILING_FACTOR = 3;

export const IMAGE_PLAN_GATE_ERROR =
  "run_build123d is blocked for this image-triggered design request. Record durable source specifications from the reference evidence, then call create_plan or revise_plan so the normalized plan covers their stable identities before running CAD.";

export function planSourceCoverageGateError(
  plan: ReturnType<typeof latestPlan>,
  specifications: readonly SourceSpecificationDto[],
): string | undefined {
  if (!isDomainPlan(plan)) return undefined;
  const active = specifications.filter((specification) => specification.status === "active").map((specification) => specification.id);
  const covered = plan.domain.source_specification_ids;
  const activeSet = new Set(active);
  const coveredSet = new Set(covered);
  const missing = active.filter((id) => !coveredSet.has(id));
  const retired = covered.filter((id) => !activeSet.has(id));
  if (missing.length === 0 && retired.length === 0 && covered.length === active.length && coveredSet.size === activeSet.size) return undefined;
  const discrepancies = [
    missing.length > 0 ? `missing current identities: ${missing.join(", ")}` : undefined,
    retired.length > 0 ? `retired identities still linked: ${retired.join(", ")}` : undefined,
  ].filter(Boolean).join("; ");
  return `run_build123d is blocked because plan source coverage is stale (${discrepancies}). Call revise_plan with set_source_specifications covering the exact active identities and any criteria operations needed for the changed requirements, then retry.`;
}

export function referenceClassificationGateError(referenceIds: readonly string[]): string {
  return `run_build123d is blocked because reference images are unclassified: ${referenceIds.join(", ")}. Record extracted evidence with record_reference_specifications, then call classify_reference for each ID with specificationIds or noSpecificationReason.`;
}

export function referenceSpecificationGateError(
  records: readonly ReferenceRecordDto[],
  specifications: readonly SourceSpecificationDto[],
): string | undefined {
  const byId = new Map(specifications.map((specification) => [specification.id, specification]));
  const failures: string[] = [];
  for (const record of records) {
    if (record.status !== "active" && record.status !== "complementary") continue;
    if (record.noSpecificationReason) continue;
    const ids = record.specificationIds ?? record.specificationLinks ?? [];
    if (ids.length === 0) {
      failures.push(`${record.referenceId} has no durable specification identities`);
      continue;
    }
    for (const id of ids) {
      const specification = byId.get(id);
      if (!specification) failures.push(`${record.referenceId} links missing specification ${id}`);
      else if (specification.status !== "active") failures.push(`${record.referenceId} links superseded specification ${id}`);
    }
  }
  if (failures.length === 0) return undefined;
  return `run_build123d is blocked because active reference evidence is not linked to current durable specifications: ${failures.join("; ")}. Record corrected evidence with record_reference_specifications, then refresh classify_reference with active specificationIds.`;
}

export function buildPlanNudgePrompt(incomplete: readonly { id: string; status: string }[]): string {
  const list = incomplete.map((c) => `"${c.id}" (${c.status})`).join(", ");
  return `${PLAN_NUDGE_MARKER} The plan still has unfinished components: ${list}. A component only counts as done after a gate-passed run declares it via COMPONENT and passes its planned checks, and the active plan records it. Use revise_plan with set_component_status and record_form_review when reference evidence requires it. A stored legacy plan must first transition through create_plan with transition_from_legacy=true. For each unfinished component, either continue building it now, or mark it blocked with a non-empty blocked_reason that clearly states the genuine limitation. Weakening checks to force closure is never acceptable. Do not stop while the plan has unfinished components and budget remains.`;
}

export function buildFusionPlanNudgePrompt(incomplete: readonly { id: string; status: string }[]): string {
  const list = incomplete.map((c) => `"${c.id}" (${c.status})`).join(", ");
  return `${PLAN_NUDGE_MARKER} The Fusion plan still has unfinished components: ${list}. Keep building: apply the next feature with run_fusion_action, repair or re-author anything that failed verification, and finish material and appearance. When every planned effect is realized, run one final inspect_fusion that requests every plan fusion_effect check (they must all pass at the final revision), then mark the component done with update_plan. If a genuine Fusion limitation prevents completion, mark the component blocked with a non-empty blocked_reason. Weakening checks to force closure is never acceptable. Do not stop while the plan has unfinished components and budget remains.`;
}

/** Repeat nudges after the first are a plain continuation order - live runs showed a
 * bare "continue" resuming productive work that the longer contract text did not. */
export function buildPlanContinuePrompt(incomplete: readonly { id: string; status: string }[]): string {
  const list = incomplete.map((c) => `"${c.id}" (${c.status})`).join(", ");
  return `${PLAN_NUDGE_MARKER} Continue. The plan still has unfinished components: ${list}. Resume the build now with the next concrete tool action instead of summarizing; only a completed plan or a genuinely blocked component ends the work.`;
}

/** One deterministic challenge for components marked blocked during this send. It
 * automates the human "continue" that repeatedly revived falsely-blocked builds,
 * while staying single-shot so an agent that has genuinely exhausted its approaches
 * is never pressure-looped into weakening checks. */
export function buildBlockedChallengePrompt(
  blocked: readonly { id: string; blocked_reason?: string }[],
  cadEnvironment: CadEnvironment,
): string {
  const list = blocked.map((c) => `"${c.id}" (${c.blocked_reason?.trim() || "no reason recorded"})`).join("; ");
  const environmentHint = cadEnvironment === "fusion"
    ? " a different construction method, plane, or datum; decomposing the feature into simpler steps; placing geometry from intended world coordinates with world_to_sketch instead of hand-mapped axes; or repairing from the measured feedback"
    : " a different construction method; decomposing the feature into simpler steps; or repairing from the measured diagnostics";
  return `${PLAN_NUDGE_MARKER} Before this stop is accepted, re-examine the newly blocked component${blocked.length === 1 ? "" : "s"}: ${list}. Blocked is a last resort for a limitation that cannot be worked around, not for approaches that merely failed so far. If ANY untried approach remains -${environmentHint} - set the component back with set_component_status and continue building now. Keep it blocked only if you can state why each plausible alternative cannot work; never weaken checks to force closure either way.`;
}
const persistenceIds = new WeakMap<object, string>();

export function registerMessagePersistenceId(message: unknown, id: string): void {
  if (typeof message === "object" && message !== null) persistenceIds.set(message, id);
}

export function getMessagePersistenceId(message: unknown): string | undefined {
  return typeof message === "object" && message !== null ? persistenceIds.get(message) : undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function retryPersistenceOnce<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch {
    await delay(PERSIST_RETRY_DELAY_MS);
    return operation();
  }
}

/**
 * Reads a File into a pi image content block ({ type: "image", data: base64, mimeType }).
 * Uses FileReader rather than File.arrayBuffer(): it avoids a manual chunked btoa encode
 * for large images and is implemented by jsdom, so tests exercise the production path.
 */
function fileToImageContent(file: File): Promise<ImageContent> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      // reader.result is a data: URL ("data:<mime>;base64,<data>"); keep only the base64.
      const dataUrl = reader.result as string;
      // A type-less File must not produce mimeType "" (providers reject it); assume PNG.
      resolve({ type: "image", data: dataUrl.slice(dataUrl.indexOf(",") + 1), mimeType: file.type || "image/png" });
    };
    reader.onerror = () => reject(reader.error ?? new Error(`failed to read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

function isAttachmentReference(block: unknown): block is AttachmentReferenceBlock {
  if (typeof block !== "object" || block === null) return false;
  const candidate = block as Partial<AttachmentReferenceBlock>;
  return (
    candidate.type === "attachment-reference" &&
    typeof candidate.attachmentId === "string" &&
    typeof candidate.mimeType === "string" &&
    (candidate.kind === "user-image" || candidate.kind === "view-sheet")
  );
}

/** Inspection pixels are never durable message content, even if tool details are malformed. */
export function normalizeInspectionEvidenceMessage(message: AgentMessage): AgentMessage {
  if (message.role !== "toolResult" || message.toolName !== "inspect_evidence" || !Array.isArray(message.content)) {
    return message;
  }
  const details = message.details as Partial<InspectionLeaseDto> | undefined;
  const evidence = Array.isArray(details?.evidence) ? details.evidence : [];
  let imageIndex = 0;
  const content = message.content.map((block) => {
    if (block.type !== "image") return block;
    const selected = evidence[imageIndex++];
    if (selected && typeof selected.attachmentId === "string" &&
        (selected.kind === "user-image" || selected.kind === "view-sheet") && typeof selected.mime === "string") {
      return {
        type: "attachment-reference",
        attachmentId: selected.attachmentId,
        kind: selected.kind,
        mimeType: selected.mime,
      } satisfies AttachmentReferenceBlock;
    }
    return { type: "text" as const, text: "[Inspection image omitted because durable lease metadata was unavailable.]" };
  });
  return { ...message, content } as AgentMessage;
}

/** Clone the model projection and replace only selected durable references with pi images. */
export async function materializeAttachmentReferences(
  messages: AgentMessage[],
  onExposure?: (trace: ImageExposureTrace) => void,
): Promise<Message[]> {
  const projectedReferences = messages.flatMap((message) => {
    const content = (message as { content?: unknown }).content;
    return Array.isArray(content) ? content.filter(isAttachmentReference) : [];
  });
  const strictVisualBatch = projectedReferences.some((reference) => reference.kind === "view-sheet") &&
    projectedReferences.some((reference) => reference.kind === "user-image");
  const currentSheetAttachmentIds = messages.flatMap((message) => {
    const content = (message as { content?: unknown }).content;
    return Array.isArray(content)
      ? content.flatMap((block: unknown) => {
          const reference = block as unknown;
          return isAttachmentReference(reference) && reference.kind === "view-sheet"
            ? [reference.attachmentId]
            : [];
        })
      : [];
  });
  const materialized = await Promise.all(
    messages.map(async (message) => {
      if ((message.role !== "user" && message.role !== "toolResult") || !Array.isArray(message.content)) {
        return message as Message;
      }
      const content = await Promise.all(
        message.content.map(async (block) => {
          const reference = block as unknown;
          if (!isAttachmentReference(reference)) return block;
          try {
            return await rest.downloadAttachment(reference.attachmentId, reference.mimeType);
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            if (strictVisualBatch) {
              throw new Error(`Visual verification batch image unavailable: ${reference.attachmentId} (${reason})`);
            }
            return { type: "text" as const, text: `[Attachment unavailable: ${reference.attachmentId} (${reason})]` };
          }
        }),
      );
      return { ...message, content } as Message;
    }),
  );
  onExposure?.({
    totalImages: materialized.reduce(
      (count, message) =>
        count + (Array.isArray(message.content) ? message.content.filter((block) => block.type === "image").length : 0),
      0,
    ),
    currentSheetImages: materialized.reduce((count, message) => {
      if (message.role !== "toolResult" || message.toolName !== "run_build123d") return count;
      return count + message.content.filter((block) => block.type === "image").length;
    }, 0),
    currentSheetAttachmentIds,
  });
  return materialized;
}

/** Builds a SessionState snapshot from current agent state, including the live streaming partial. */
function snapshotState(
  agent: Agent,
  referenceRecords: readonly ReferenceRecordDto[],
  sourceSpecifications: readonly SourceSpecificationDto[],
  proofContracts: readonly ProofContractDto[],
  proofReports: readonly ProofReportDto[],
  designEscalations: readonly DesignEscalationDto[],
  referenceRegistrations: readonly ReferenceRegistrationDto[],
  error: SessionError | undefined,
  notice: SessionNotice | undefined,
): SessionState {
  const messages: unknown[] = agent.state.messages.slice();
  if (agent.state.isStreaming && agent.state.streamingMessage) {
    messages.push(agent.state.streamingMessage);
  }
  return {
    messages,
    referenceRecords: [...referenceRecords],
    sourceSpecifications: [...sourceSpecifications],
    proofContracts: [...proofContracts],
    proofReports: [...proofReports],
    designEscalations: [...designEscalations],
    referenceRegistrations: [...referenceRegistrations],
    streaming: agent.state.isStreaming,
    error,
    notice,
  };
}

export function createSession(opts: CreateSessionOptions): ChatSession {
  const cadEnvironment = opts.cadEnvironment ?? "build123d";
  const model = JSON.parse(opts.modelJson) as Model<Api>;
  const priorMessages = opts.priorMessages as AgentMessage[];
  let referenceRecords = [...(opts.referenceRecords ?? [])];
  let sourceSpecifications = [...(opts.sourceSpecifications ?? [])];
  let proofContracts = [...(opts.proofContracts ?? [])];
  let proofReports = [...(opts.proofReports ?? [])];
  let designEscalations = [...(opts.designEscalations ?? [])];
  let referenceRegistrations = [...(opts.referenceRegistrations ?? [])];
  let openInspectionLeases = [...(opts.openInspectionLeases ?? [])];
  let latestVisualVerification = opts.visualVerifications?.at(-1);
  let visualVerificationBatches = [...(opts.visualVerificationBatches ?? [])];
  let projectedVisualBatchPlan: VisualVerificationBatchPlan | undefined;
  const pendingThisTurn = new Set<string>();
  const imageReferenceIds = new WeakMap<object, string>();
  type SteeringEntry = {
    message?: AgentMessage;
    status: "preparing" | "ready" | "offered" | "consuming";
    attachmentIds: string[];
    ready: Promise<void>;
    resolveReady: () => void;
    resolve: (outcome: "consumed" | "cancelled") => void;
    promise: Promise<"consumed" | "cancelled">;
  };
  const steeringEntries = new Map<string, SteeringEntry>();
  const steeringIds = new WeakMap<object, string>();
  let persistQueue: Promise<void> = Promise.resolve();
  let blockedWeakeningReasons: string[] = [];
  let activeRunReporter: AgentRunReporter | undefined;
  let abortRequested = false;

  const terminalPriorMessage = priorMessages.at(-1) as
    | { role?: string; stopReason?: string; errorMessage?: string }
    | undefined;
  let lastError =
    terminalPriorMessage?.role === "assistant" &&
    terminalPriorMessage.stopReason === "error" &&
    terminalPriorMessage.errorMessage
      ? classifySessionError(terminalPriorMessage.errorMessage)
      : undefined;
  let notice: SessionNotice | undefined;
  const listeners = new Set<(state: SessionState) => void>();

  // Transient provider failures are retried inside the stream function, invisibly to
  // the agent loop; the notice keeps the user informed while the session waits.
  const streamFn = withStreamRetry(opts.__streamFn ?? buildStreamFn(opts.conversationId), {
    ...opts.__retryOptions,
    onWait: ({ attempt, maxAttempts, delayMs }) => {
      notice = { kind: "retrying", attempt, maxAttempts, delaySeconds: Math.ceil(delayMs / 1000) };
      activeRunReporter?.recordRetry(attempt, delayMs);
      notify();
    },
    onResume: () => {
      notice = undefined;
      notify();
    },
  });

  let imagePlanRequiredThisTurn = false;
  let imagePlanAcceptedThisTurn = false;
  let imagePlanRequiredAtSend = false;
  let consumedSteeringImagePlanRequired = false;

  // Plan tools and load_skill validate against the live transcript, so they are
  // session-owned. The closures resolve to the agent created just below.
  let agentForPlanTool: Agent | undefined;
  async function freezeEligibleProofContract(plan: ReturnType<typeof latestPlan>): Promise<void> {
    const input = deriveProofContract(plan, sourceSpecifications, referenceRegistrations);
    if (!input || currentProofContract(proofContracts, plan, referenceRegistrations)) return;
    const frozen = await rest.freezeProofContract(opts.conversationId, input);
    proofContracts = [
      ...proofContracts
        .filter((contract) => contract.contractId !== frozen.contractId || contract.revision !== frozen.revision)
        .map((contract) => ({ ...contract, status: "stale" as const, proofStatus: "stale" as const })),
      frozen,
    ];
    notify();
  }
  const retiredPlanTool = createRetiredUpdatePlanTool({
    getMessages: () => agentForPlanTool?.state.messages ?? [],
  }) as unknown as AgentTool;
  const legacySnapshotPlanTool = createUpdatePlanTool({
    getMessages: () => agentForPlanTool?.state.messages ?? [],
    requireSpecSheet: () => imagePlanRequiredThisTurn,
    onAccepted: () => {
      if (imagePlanRequiredThisTurn) imagePlanAcceptedThisTurn = true;
    },
  }) as unknown as AgentTool;
  const snapshotPlanTool = opts.sourceSpecificationsRequired
    ? retiredPlanTool
    : legacySnapshotPlanTool;
  const createPlanTool = createCreatePlanTool({
    getMessages: () => agentForPlanTool?.state.messages ?? [],
    getSourceSpecificationIds: () => sourceSpecifications
      .filter((specification) => specification.status === "active")
      .map((specification) => specification.id),
    getSourceSpecifications: () => sourceSpecifications,
    onAccepted: async (plan) => {
      if (imagePlanRequiredThisTurn) imagePlanAcceptedThisTurn = true;
      // Plan acceptance remains durable even if the contract endpoint is briefly
      // unavailable. The non-probe CAD preflight retries and blocks delivery until
      // the contract is durably frozen.
      await freezeEligibleProofContract(plan).catch(() => undefined);
    },
  }) as unknown as AgentTool;
  const revisePlanTool = createRevisePlanTool({
    getMessages: () => agentForPlanTool?.state.messages ?? [],
    getSourceSpecifications: () => sourceSpecifications,
    getProofContracts: () => proofContracts,
    getReferenceRegistrations: () => referenceRegistrations,
    getActiveReferenceIds: () => referenceRecords
      .filter((record) => record.status === "active" || record.status === "complementary")
      .map((record) => record.referenceId),
    onAccepted: async (plan) => {
      if (imagePlanRequiredThisTurn) imagePlanAcceptedThisTurn = true;
      await freezeEligibleProofContract(plan).catch(() => undefined);
    },
  }) as unknown as AgentTool;

  // The "none" and "core" ablation arms predate the skill layer and must not
  // expose it; "catalog" and "full" both register the tool ("full" keeps it so a
  // model that asks anyway gets the dedupe notice instead of an unknown-tool error).
  const skillMode = cadEnvironment === "build123d" ? (opts.skillMode ?? DEFAULT_SKILL_MODE) : "none";
  const skillTools: AgentTool[] =
    cadEnvironment === "fusion" || skillMode === "catalog" || skillMode === "full"
      ? [createLoadSkillTool({ cadEnvironment, getMessages: () => agentForPlanTool?.state.messages ?? [] }) as unknown as AgentTool]
      : [];

  function acceptClassification(classification: ReferenceClassificationDto): void {
    pendingThisTurn.delete(classification.referenceId);
    const existing = referenceRecords.find((record) => record.referenceId === classification.referenceId);
    const next: ReferenceRecordDto = {
      referenceId: classification.referenceId,
      conversationId: classification.conversationId,
      attachmentAvailable: existing?.attachmentAvailable ?? true,
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
      history: [...(existing?.history ?? []).filter((item) => item.id !== classification.id), classification],
    };
    referenceRecords = existing
      ? referenceRecords.map((record) => record.referenceId === classification.referenceId ? next : record)
      : [...referenceRecords, next];
  }

  const classificationTool = createClassifyReferenceTool({
    persistPending: () => persistQueue,
    classify: (input, key) => rest.classifyReference(opts.conversationId, input, key),
    onAccepted: acceptClassification,
  }) as unknown as AgentTool;

  const registrationTool = createRegisterReferenceViewTool({
    persistPending: () => persistQueue,
    download: rest.downloadAttachment,
    register: (input, key) => rest.registerReference(opts.conversationId, input, key),
    onAccepted: (registration) => {
      referenceRegistrations = [
        ...referenceRegistrations
          .filter((candidate) => candidate.registrationId !== registration.registrationId || candidate.revision !== registration.revision)
          .map((candidate) => candidate.registrationId === registration.registrationId
            ? { ...candidate, status: "stale" as const }
            : candidate),
        registration,
      ];
      proofContracts = proofContracts.map((contract) => {
        if (contract.derivation.shapeProof.status === "not-applicable") return contract;
        const dependedOnReference = contract.derivation.shapeProof.registrations.some((binding) =>
          binding.referenceId === registration.referenceId && binding.revision !== registration.revision,
        );
        return dependedOnReference
          ? { ...contract, status: "stale" as const, proofStatus: "stale" as const }
          : contract;
      });
      notify();
    },
  }) as unknown as AgentTool;

  const inspectEvidenceTool = createInspectEvidenceTool({
    persistPending: () => persistQueue,
    openLease: (input, key) => rest.openInspectionLease(opts.conversationId, input, key),
    download: rest.downloadAttachment,
    onOpened: (lease) => {
      openInspectionLeases = [...openInspectionLeases.filter((candidate) => candidate.id !== lease.id), lease];
    },
  }) as unknown as AgentTool;
  const recordObservationTool = createRecordInspectionObservationTool({
    persistPending: () => persistQueue,
    record: (leaseId, input, key) => rest.recordInspectionObservation(opts.conversationId, leaseId, input, key),
    onClosed: (lease) => {
      openInspectionLeases = openInspectionLeases.filter((candidate) => candidate.id !== lease.id);
    },
  }) as unknown as AgentTool;
  const visualVerificationBatchTool = createRecordVisualVerificationBatchTool({
    persistPending: () => persistQueue,
    record: (input, key) => rest.recordVisualVerificationBatch(opts.conversationId, input, key),
    onAccepted: (record) => {
      visualVerificationBatches = [...visualVerificationBatches.filter((item) => item.id !== record.id), record];
      if (record.finalVerification) latestVisualVerification = record.finalVerification;
      visualNudgedWithoutProgress = false;
    },
  }) as unknown as AgentTool;
  function acceptSpecifications(accepted: SourceSpecificationDto[], resolvesEscalationId?: string): void {
    const byId = new Map(sourceSpecifications.map((specification) => [specification.id, specification]));
    for (const specification of accepted) {
      const supersededIds = specification.supersedesSpecificationIds ??
        (specification.supersedesSpecificationId ? [specification.supersedesSpecificationId] : []);
      for (const supersededId of supersededIds) {
        const superseded = byId.get(supersededId);
        if (superseded) {
          byId.set(superseded.id, {
            ...superseded,
            status: "superseded",
            supersededBySpecificationId: specification.id,
          });
        }
      }
      byId.set(specification.id, specification);
    }
    sourceSpecifications = [...byId.values()];
    if (resolvesEscalationId) {
      designEscalations = designEscalations.map((escalation) =>
        escalation.escalationId === resolvesEscalationId && escalation.status === "pending"
          ? {
              ...escalation,
              status: "resolved" as const,
              resolvedAt: Date.now(),
              resolutionSpecificationIds: accepted.map((specification) => specification.id),
            }
          : escalation,
      );
      blockedWeakeningReasons = [];
    }
    notify();
  }

  const sourceSpecificationTool = createRecordSourceSpecificationsTool({
    persistPending: () => persistQueue,
    sourceMessage: () => {
      const messages = agentForPlanTool?.state.messages ?? priorMessages;
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index]!;
        const text = sourceTextOf(message);
        const id = getMessagePersistenceId(message);
        if (text !== undefined && id) return { id, text };
      }
      return undefined;
    },
    record: (input, key) => rest.recordSourceSpecifications(opts.conversationId, input, key),
    onAccepted: acceptSpecifications,
  }) as unknown as AgentTool;
  const referenceSpecificationTool = createRecordReferenceSpecificationsTool({
    persistPending: () => persistQueue,
    record: (input, key) => rest.recordSourceSpecifications(opts.conversationId, input, key),
    onAccepted: acceptSpecifications,
  }) as unknown as AgentTool;
  const clarificationTool = createRequestDesignClarificationTool({
    persistPending: () => persistQueue,
    open: (input, key) => rest.openDesignEscalation(opts.conversationId, input, key),
    validate: (input: OpenDesignEscalationInput) => validateDesignEscalationRequest(
      input,
      sourceSpecifications,
      designEscalations,
      blockedWeakeningReasons,
    ),
    onAccepted: (escalation) => {
      designEscalations = [...designEscalations, escalation];
      notify();
    },
  }) as unknown as AgentTool;

  const environmentTools = cadEnvironment === "build123d"
    ? [
        ...((opts.tools ?? []) as AgentTool[]),
        classificationTool,
        registrationTool,
        inspectEvidenceTool,
        recordObservationTool,
        visualVerificationBatchTool,
        sourceSpecificationTool,
        referenceSpecificationTool,
        clarificationTool,
        createPlanTool,
        revisePlanTool,
        snapshotPlanTool,
        ...skillTools,
      ]
    : [
        ...((opts.tools ?? []) as AgentTool[]).filter((tool) => fusionToolMayBeInjected(tool.name)),
        ...(opts.executeFusionAction ? [createRunFusionActionTool({
          execute: opts.executeFusionAction,
          model: { provider: model.provider, model: model.id },
          skillAttribution: () => fusionSkillAttribution(agentForPlanTool?.state.messages ?? priorMessages),
          inspectionIdentity: () => latestFusionInspectionIdentity(agentForPlanTool?.state.messages ?? priorMessages),
          destructiveAuthority: (revision, intent) => destructiveAuthorityFromMessages(
            agentForPlanTool?.state.messages ?? priorMessages,
            getMessagePersistenceId,
            revision,
            intent,
          ),
          reconciliationAuthority: (revision, intent, affectedReferences) => reconciliationAuthorityFromMessages(
            agentForPlanTool?.state.messages ?? priorMessages,
            getMessagePersistenceId,
            revision,
            intent,
            affectedReferences,
          ),
        }) as unknown as AgentTool] : []),
        classificationTool,
        inspectEvidenceTool,
        recordObservationTool,
        visualVerificationBatchTool,
        legacySnapshotPlanTool,
        ...skillTools,
      ];

  const agent = new Agent({
    initialState: {
      systemPrompt: opts.systemPrompt,
      model,
      tools: environmentTools,
    },
    streamFn,
    beforeToolCall: async ({ toolCall, args }) => {
      if (openInspectionLeases.length > 0 && toolCall.name !== "record_inspection_observation") {
        return {
          block: true,
          reason: `Tool ${toolCall.name} is blocked while inspection lease${openInspectionLeases.length === 1 ? "" : "s"} ${openInspectionLeases.map((lease) => lease.id).join(", ")} remain open. Record structured observations for every open lease before any other tool action.`,
        };
      }
      if (toolCall.name === "record_visual_verification_batch") {
        const evidence = currentVisualEvidence(opts.conversationId, agentForPlanTool?.state.messages ?? priorMessages, referenceRecords);
        if (!evidence) return { block: true, reason: "no current visual evidence is available for batching" };
        const plan = planVisualVerificationBatches(evidence, model as Model<Api> & { maxInputImages?: number }, referenceRecords);
        const progress = reconcileVisualVerificationBatches(plan, visualVerificationBatches);
        const reason = validateProjectedVisualBatchInput(plan, progress, args as RecordVisualVerificationBatchInput);
        if (reason) return { block: true, reason };
      }
      const currentPlan = latestPlan(agentForPlanTool?.state.messages ?? priorMessages);
      const submittedCadCode = toolCall.name === "run_build123d" && typeof (args as { code?: unknown }).code === "string"
        ? (args as { code: string }).code
        : "";
      const affectsDeliverable = toolCall.name === CREATE_PLAN_TOOL_NAME ||
        toolCall.name === REVISE_PLAN_TOOL_NAME ||
        toolCall.name === UPDATE_PLAN_TOOL_NAME ||
        (toolCall.name === "run_build123d" && !isProbeCadCode(submittedCadCode));
      if (affectsDeliverable) {
        const escalationFailure = designActionEscalationError(sourceSpecifications, designEscalations);
        if (escalationFailure) return { block: true, reason: escalationFailure };
      }
      if (toolCall.name === CREATE_PLAN_TOOL_NAME) {
        if (opts.sourceSpecificationsRequired && !sourceSpecifications.some((specification) => specification.status === "active")) {
          return {
            block: true,
            reason: "The first text design plan requires durable source specifications. Call record_source_specifications with every explicit requirement and exact source quotes, then retry create_plan.",
          };
        }
      }
      if (toolCall.name === REVISE_PLAN_TOOL_NAME && currentPlan && !isDomainPlan(currentPlan)) {
        return {
          block: true,
          reason: "This is a read-only legacy snapshot. Call create_plan once with transition_from_legacy=true and the complete normalized active legacy state, then retry the change with revise_plan.",
        };
      }
      if (toolCall.name === UPDATE_PLAN_TOOL_NAME && isDomainPlan(currentPlan)) {
        return {
          block: true,
          reason: "update_plan is retired for the authoritative domain plan. Call revise_plan with one atomic batch of explicit domain operations.",
        };
      }
      if (toolCall.name === REVISE_PLAN_TOOL_NAME && isDomainPlan(currentPlan)) {
        const reasons = explicitRequirementWeakeningReasons(
          currentPlan,
          args as unknown as DomainPlanRevisionBatch,
          sourceSpecifications,
          currentProofContract(proofContracts, currentPlan, referenceRegistrations),
        );
        if (reasons.length > 0) {
          blockedWeakeningReasons = reasons;
          return {
            block: true,
            reason: `This autonomous plan revision would weaken or materially reinterpret an explicit user requirement: ${reasons.join("; ")}. Call request_design_clarification with kind explicit-requirement-change and one focused question before proceeding.`,
          };
        }
      }
      if (toolCall.name === "run_build123d" || toolCall.name === "run_fusion_action") {
        const unclassified = new Set([
          ...pendingReferenceIds(agentForPlanTool?.state.messages ?? priorMessages, referenceRecords),
          ...pendingThisTurn,
        ]);
        if (unclassified.size > 0) {
          return { block: true, reason: referenceClassificationGateError([...unclassified]) };
        }
      }
      if (toolCall.name === "run_build123d") {
        const specificationFailure = referenceSpecificationGateError(referenceRecords, sourceSpecifications);
        if (specificationFailure) return { block: true, reason: specificationFailure };
        const coverageFailure = planSourceCoverageGateError(currentPlan, sourceSpecifications);
        if (coverageFailure) return { block: true, reason: coverageFailure };
        const code = submittedCadCode;
        if (!isProbeCadCode(code)) {
          const missingRegistrations = unregisteredReferenceIds(referenceRecords, referenceRegistrations);
          if (missingRegistrations.length > 0) {
            return { block: true, reason: referenceRegistrationGateError(missingRegistrations) };
          }
        }
        if (!isProbeCadCode(code) && deriveProofContract(currentPlan, sourceSpecifications, referenceRegistrations) &&
            !currentProofContract(proofContracts, currentPlan, referenceRegistrations)) {
          try {
            await freezeEligibleProofContract(currentPlan);
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            return {
              block: true,
              reason: `run_build123d is blocked because Chamfer could not durably freeze the autonomous proof contract: ${reason}`,
            };
          }
        }
        const contractFailure = proofContractPreflightError(
          currentPlan,
          sourceSpecifications,
          proofContracts,
          code,
          referenceRegistrations,
        );
        if (contractFailure) return { block: true, reason: contractFailure };
      }
      if ((toolCall.name === "run_build123d" || toolCall.name === "run_fusion_action") && imagePlanRequiredThisTurn && !imagePlanAcceptedThisTurn) {
        return { block: true, reason: IMAGE_PLAN_GATE_ERROR };
      }
      if (toolCall.name === "run_fusion_action") {
        const plan = latestPlan(agentForPlanTool?.state.messages ?? priorMessages);
        if (!plan) return { block: true, reason: "Create and accept an explicit Fusion design plan with update_plan (declaring one fusion_effect check per intended effect) before mutating the authoritative document." };
        const errors = validateFusionActionPlan(plan);
        if (errors.length > 0) return { block: true, reason: errors.join("; ") };
      }
      return undefined;
    },
    afterToolCall: async ({ toolCall, args, result, isError, context }) => {
      if (cadEnvironment === "fusion") {
        const additionalResult = toolCall.name === "load_skill"
          ? { role: "toolResult", toolName: "load_skill", isError, details: result.details }
          : undefined;
        const originalDetails = typeof result.details === "object" && result.details !== null ? result.details : {};
        return {
          details: {
            ...originalDetails,
            skillAttribution: fusionSkillAttribution(context.messages, additionalResult),
          },
        };
      }
      if (toolCall.name !== "run_build123d") return undefined;
      const rawDetails = (result.details && typeof result.details === "object")
        ? result.details as RunBuild123dDetails
        : undefined;
      const { evaluationMesh, ...durableDetails } = rawDetails ?? {} as RunBuild123dDetails;
      let conformanceDetails: Record<string, unknown> = durableDetails;
      let shapeProof: ShapeProofRecord | undefined;
      if (!isError) {
        const activePlan = latestPlan(context.messages);
        const measurements = rawDetails?.measurements;
        if (activePlan && measurements && typeof measurements === "object") {
          const errors = validateRunChecksConformance(activePlan, measurements);
          const contract = currentProofContract(proofContracts, activePlan, referenceRegistrations);
          const proofErrors = contract
            ? proofRunIdentityErrors(activePlan, contract, measurements as Measurements)
            : [];
          const conformanceErrors = [...errors, ...proofErrors];
          if (isDomainPlan(activePlan)) {
            const componentCriteriaRevisions = Object.fromEntries(
              runComponentIds(measurements as { component?: unknown }).flatMap((componentId) => {
                const component = activePlan.components.find((candidate) => candidate.id === componentId);
                return typeof component?.criteria_revision === "number"
                  ? [[componentId, component.criteria_revision] as const]
                  : [];
              }),
            );
            const planConformance: PlanConformanceRecord = {
              status: conformanceErrors.length === 0 ? "passed" : "failed",
              planId: activePlan.domain.plan_id,
              componentCriteriaRevisions,
            };
            conformanceDetails = {
              ...conformanceDetails,
              planConformance,
            };
          }
          const submittedCode = typeof (args as { code?: unknown })?.code === "string"
            ? (args as { code: string }).code
            : "";
          if (contract?.derivation.shapeProof.status === "required" && !isProbeCadCode(submittedCode)) {
            const bindings = contract.derivation.shapeProof.registrations.filter((binding) => binding.eligibility === "eligible");
            const registrations = bindings.flatMap((binding) => {
              const registration = referenceRegistrations.find((candidate) =>
                candidate.registrationId === binding.registrationId &&
                candidate.revision === binding.revision &&
                candidate.status === "current");
              return registration ? [registration] : [];
            });
            const activeReferenceIds = referenceRecords
              .filter((record) => record.status === "active" || record.status === "complementary")
              .map((record) => record.referenceId);
            try {
              if (!evaluationMesh) throw new Error("the successful CAD result did not retain an evaluation mesh");
              shapeProof = await evaluateMultiViewShapeProof(
                evaluationMesh,
                contract,
                registrations,
                {
                  artifactId: rawDetails?.code?.artifactId,
                  artifactVersion: rawDetails?.code?.artifactVersion,
                },
                activeReferenceIds,
              );
            } catch (error) {
              shapeProof = shapeProofErrorRecord(
                contract,
                registrations[0],
                {
                  artifactId: rawDetails?.code?.artifactId,
                  artifactVersion: rawDetails?.code?.artifactVersion,
                },
                error,
              );
            }
            conformanceDetails = { ...conformanceDetails, shapeProof };
          }
          if (errors.length > 0) {
            const content = Array.isArray(result.content) ? result.content : [];
            return {
              content: [
                {
                  type: "text",
                  text: `Plan conformance: FAILED\n${errors.map((error) => `- ${error}`).join("\n")}`,
                },
                ...content,
              ],
              details: conformanceDetails,
              isError: true,
            };
          }
          if (proofErrors.length > 0) {
            const content = Array.isArray(result.content) ? result.content : [];
            return {
              content: [
                {
                  type: "text",
                  text: `Single-component integrity: FAILED\n${proofErrors.map((error) => `- ${error}`).join("\n")}\nThe diagnostic geometry and inspection sheet remain current for repair.`,
                },
                ...content,
              ],
              details: conformanceDetails,
            };
          }
          if (shapeProof && shapeProof.status !== "passed") {
            const content = Array.isArray(result.content) ? result.content : [];
            const heading = shapeProof.status === "failed" ? "FAILED" : "UNAVAILABLE";
            return {
              content: [
                {
                  type: "text",
                  text: `Independent shape proof: ${heading}\n- ${shapeProof.worst.detail}\n- Coverage ${shapeProof.views.filter((view) => view.status === "passed").length}/${shapeProof.coverage.requiredRegistrationIds.length} required views; worst metric ${shapeProof.worst.metric}${shapeProof.worst.landmarkId ? ` at landmark ${shapeProof.worst.landmarkId}` : ""}.\n- Evaluator ${shapeProof.evaluator.id} v${shapeProof.evaluator.version}, policy ${shapeProof.policy.id} v${shapeProof.policy.version}.\nThe diagnostic geometry and inspection sheet remain current for repair. Correct the CAD geometry without changing the registered targets or threshold policy; every view will refresh against the new artifact.`,
                },
                ...content,
              ],
              details: conformanceDetails,
            };
          }
        }
      }
      if (skillTools.length === 0) return { details: conformanceDetails };
      const nudge = skillNudgeBlock(context.messages, result, isError);
      if (!nudge) return { details: conformanceDetails };
      const content = Array.isArray(result.content) ? result.content : [];
      return { content: [...content, nudge], details: conformanceDetails };
    },
    // The persisted transcript is the source of truth; what the model sees is the
    // policy-transformed view (stale view sheets stubbed, compacted history windowed).
    transformContext: async (messages) => {
      const projected = projectInspectionLeases(
        projectClassifiedReferences(
          transformLlmContext(messages),
          referenceRecords,
          (image) => imageReferenceIds.get(image),
        ),
        openInspectionLeases,
      );
      const withSourceSpecifications = projectSourceSpecifications(projected, sourceSpecifications);
      const withEscalations = projectDesignEscalations(withSourceSpecifications, designEscalations);
      const withReferenceRegistrations = projectReferenceRegistrations(withEscalations, referenceRegistrations);
      const withAuthoritativePlan = projectAuthoritativePlan(withReferenceRegistrations, messages);
      const evidence = currentVisualEvidence(opts.conversationId, messages, referenceRecords);
      const limits = model as Model<Api> & { maxInputImages?: number };
      const currentBatchPlan = evidence?.activeReferenceIds.length
        ? planVisualVerificationBatches(evidence, limits, referenceRecords)
        : undefined;
      const batchPlan = preferQueuedVisualBatchPlan(currentBatchPlan, projectedVisualBatchPlan);
      if (!batchPlan) return withAuthoritativePlan;
      return projectVisualVerificationBatch(
        withAuthoritativePlan,
        messages,
        batchPlan,
        reconcileVisualVerificationBatches(batchPlan, visualVerificationBatches),
      );
    },
    convertToLlm: (messages) => materializeAttachmentReferences(
      cadEnvironment === "fusion" ? projectFusionModelContext(messages) : messages,
      opts.__onImageExposure,
    ),
  });
  agentForPlanTool = agent;
  agent.state.messages = priorMessages;

  let nextSeq = Number.isInteger(opts.nextMessageSeq) && opts.nextMessageSeq! >= 0
    ? opts.nextMessageSeq!
    : priorMessages.length;

  function notify(): void {
    const state = snapshotState(
      agent,
      referenceRecords,
      sourceSpecifications,
      proofContracts,
      proofReports,
      designEscalations,
      referenceRegistrations,
      lastError,
      notice,
    );
    for (const listener of listeners) listener(state);
  }

  function rebuildOfferedSteeringQueue(): void {
    agent.clearSteeringQueue();
    for (const entry of steeringEntries.values()) {
      if (entry.status === "offered" && entry.message) agent.steer(entry.message);
    }
  }

  function recomputeImagePlanRequirement(): void {
    imagePlanRequiredThisTurn = imagePlanRequiredAtSend || consumedSteeringImagePlanRequired ||
      [...steeringEntries.values()].some((entry) =>
        entry.status === "consuming" && entry.attachmentIds.length > 0,
      );
  }

  function removeSteeringGateState(entry: SteeringEntry): void {
    for (const attachmentId of entry.attachmentIds) pendingThisTurn.delete(attachmentId);
    recomputeImagePlanRequirement();
  }

  function cancelPendingSteering(): void {
    agent.clearSteeringQueue();
    const pending = [...steeringEntries.values()];
    steeringEntries.clear();
    for (const entry of pending) {
      removeSteeringGateState(entry);
      entry.resolveReady();
      entry.resolve("cancelled");
    }
  }

  async function offerReadySteeringAtTurnBoundary(): Promise<void> {
    while (true) {
      const preparing = [...steeringEntries.values()]
        .filter((entry) => entry.status === "preparing")
        .map((entry) => entry.ready);
      if (preparing.length === 0) break;
      await Promise.all(preparing);
    }
    for (const entry of steeringEntries.values()) {
      if (entry.status === "preparing") break;
      if (entry.status !== "ready" || !entry.message) continue;
      entry.status = "offered";
      agent.steer(entry.message);
    }
  }

  // Persistence must never throw back into the agent loop: a rejection escaping this
  // listener is caught by pi's runWithLifecycle and routed into handleRunFailure, which
  // fabricates a synthetic error assistant message and persists that instead of (or after)
  // the real one, permanently corrupting the seq sequence. A sequential promise-chain queue
  // keeps persistence ordered without ever letting a failure surface to the caller: each
  // message gets one retry, and a final failure records state.error but still consumes its
  // seq slot (the gap is documented via the error, not left dangling).
  /**
   * Replaces native image blocks with ordered durable references and retains the binary
   * upload work needed to make each reference resolvable through REST.
   */
  function normalizeMessageAttachments(message: AgentMessage): {
    durable: AgentMessage;
    uploads: Array<{ id: string; kind: AttachmentReferenceBlock["kind"]; image: ImageContent }>;
  } {
    if ((message.role !== "user" && message.role !== "toolResult") || !Array.isArray(message.content)) {
      return { durable: message, uploads: [] };
    }
    if (message.role === "toolResult" && message.toolName === "inspect_evidence") {
      return { durable: normalizeInspectionEvidenceMessage(message), uploads: [] };
    }
    const kind = message.role === "user" ? "user-image" : ["run_build123d", "run_fusion_action", "inspect_fusion"].includes(String(message.toolName)) ? "view-sheet" : undefined;
    if (!kind) return { durable: message, uploads: [] };
    const uploads: Array<{ id: string; kind: AttachmentReferenceBlock["kind"]; image: ImageContent }> = [];
    const content = message.content.map((block) => {
      if (block.type !== "image") return block;
      const id = imageReferenceIds.get(block) ?? crypto.randomUUID();
      uploads.push({ id, kind, image: block });
      return { type: "attachment-reference", attachmentId: id, kind, mimeType: block.mimeType } satisfies AttachmentReferenceBlock;
    });
    const durable = { ...message, content } as AgentMessage;
    const sheet = uploads.find((upload) => upload.kind === "view-sheet");
    return {
      durable: sheet ? withInspectionSheetEvidence(durable, sheet.id) : durable,
      uploads,
    };
  }

  function queuePersist(seq: number, message: AgentMessage): void {
    const messageId = crypto.randomUUID();
    const reporter = activeRunReporter;
    const persistenceStartedAt = Date.now();
    registerMessagePersistenceId(message, messageId);
    const normalized = normalizeMessageAttachments(message);
    registerMessagePersistenceId(normalized.durable, messageId);
    persistQueue = persistQueue.then(async () => {
      const payload = {
        id: messageId,
        seq,
        role: message.role,
        contentJson: JSON.stringify(normalized.durable),
      };
      if (normalized.uploads.length > 0) {
        let succeeded = false;
        try {
          await retryPersistenceOnce(() => rest.postMessageWithAttachments(
            opts.conversationId,
            payload,
            normalized.uploads.map((upload) => ({
              id: upload.id,
              kind: upload.kind,
              mime: upload.image.mimeType,
              data: upload.image.data,
            })),
          ));
          agent.state.messages = agent.state.messages.map((candidate) =>
            candidate === message ? normalized.durable : candidate,
          );
          succeeded = true;
        } catch (attachmentError) {
          const reason = attachmentError instanceof Error ? attachmentError.message : String(attachmentError);
          lastError = { kind: "generic", message: `attachment-persist-failed: ${reason}` };
          notify();
        } finally {
          reporter?.recordPersistence(messageId, succeeded, Math.max(0, Date.now() - persistenceStartedAt));
        }
        return;
      }
      let persisted = false;
      try {
        await rest.postMessage(opts.conversationId, payload);
        persisted = true;
      } catch {
        await delay(PERSIST_RETRY_DELAY_MS);
        try {
          await rest.postMessage(opts.conversationId, payload);
          persisted = true;
        } catch (retryError) {
          const reason = retryError instanceof Error ? retryError.message : String(retryError);
          // Persistence failures keep their specific text but are always "generic":
          // neither an API-key hint nor a retry-the-turn affordance would fix them.
          lastError = { kind: "generic", message: `persist-failed: ${reason}` };
          notify();
        }
      }
      if (persisted && normalized.durable !== message) {
        agent.state.messages = agent.state.messages.map((candidate) =>
          candidate === message ? normalized.durable : candidate,
        );
      }
      reporter?.recordPersistence(messageId, persisted, Math.max(0, Date.now() - persistenceStartedAt));
    });
  }

  const maxCadRuns =
    opts.maxCadRuns && Number.isInteger(opts.maxCadRuns) && opts.maxCadRuns > 0
      ? opts.maxCadRuns
      : DEFAULT_MAX_CAD_RUNS;
  const configurationIdentity = createAgentConfigurationTraceIdentity({
    modelJson: opts.modelJson,
    systemPrompt: opts.systemPrompt,
    toolNames: agent.state.tools.map((tool) => tool.name),
    skillMode,
    maxCadRuns,
  });
  let cadRunsThisTurn = 0;
  let cadRunLimitReached = false;
  // Self-check: armed once per send(); fires when the agent is about to stop after a
  // gate pass, nudging it to verify the WHOLE request is satisfied, not just the gate.
  let gatePassedThisTurn = false;
  let selfCheckArmed = false;
  // Plan enforcement. With an active plan the budget is per component bucket (the
  // COMPONENT declaration parsed from the script; probe runs drain only the global
  // ceiling), and stopping with unfinished components triggers bounded deterministic
  // follow-ups. `planNudgesWithoutRun` counts consecutive nudges with no intervening
  // CAD run; the budget resets whenever a run executes, so a working agent is never
  // interrupted while an idling one gets MAX_PLAN_NUDGES_WITHOUT_RUN chances before
  // the session surfaces the stop.
  const cadRunsByBucket = new Map<string, number>();
  let planNudgesWithoutRun = 0;
  let visualNudgedWithoutProgress = false;
  // Autonomous continuation bookkeeping: CAD runs that completed since the last
  // budget renewal (progress evidence), and the blocked-component challenge state
  // for this send (only components that became blocked during this send are
  // challenged, exactly once).
  let productiveRunsThisWindow = 0;
  const challengedBlockedComponents = new Set<string>();
  let blockedAtSendStart = new Set<string>();
  let currentTurn: { id: string; startedAt: number } | undefined;
  const toolOperations = new Map<string, { id: string; startedAt: number }>();
  let lastRunStopReason: string | undefined;

  agent.subscribe(async (event: AgentEvent) => {
    if (event.type === "turn_start") {
      currentTurn = { id: crypto.randomUUID(), startedAt: Date.now() };
      await activeRunReporter?.operationStarted("turn", currentTurn.id);
    }
    if (event.type === "turn_end") {
      // Recorded unconditionally: a pre-content stream failure can end a turn that
      // never reported turn_start, and the autonomous resume loop keys off this.
      const stopReason = (event.message as { stopReason?: string }).stopReason;
      lastRunStopReason = stopReason;
      if (currentTurn) {
        activeRunReporter?.operationCompleted(
          "turn",
          currentTurn.id,
          stopReason === "aborted" ? "aborted" : stopReason === "error" ? "error" : "ok",
          Math.max(0, Date.now() - currentTurn.startedAt),
        );
        currentTurn = undefined;
      }
    }
    if (event.type === "tool_execution_start") {
      const operation = { id: crypto.randomUUID(), startedAt: Date.now() };
      toolOperations.set(event.toolCallId, operation);
      void activeRunReporter?.operationStarted("tool", operation.id, event.toolName);
    }
    if (event.type === "tool_execution_end") {
      const operation = toolOperations.get(event.toolCallId);
      if (operation) {
        activeRunReporter?.operationCompleted(
          "tool",
          operation.id,
          event.isError ? "error" : "ok",
          Math.max(0, Date.now() - operation.startedAt),
        );
        toolOperations.delete(event.toolCallId);
      }
    }
    if (event.type === "message_start") {
      const steeringId = steeringIds.get(event.message);
      const entry = steeringId ? steeringEntries.get(steeringId) : undefined;
      if (entry) {
        entry.status = "consuming";
        if (entry.attachmentIds.length > 0) {
          for (const attachmentId of entry.attachmentIds) pendingThisTurn.add(attachmentId);
          consumedSteeringImagePlanRequired = true;
          imagePlanRequiredThisTurn = true;
        }
      }
    }
    if (
      event.type === "turn_end" &&
      event.message.role === "assistant" &&
      event.message.stopReason !== "error" &&
      event.message.stopReason !== "aborted"
    ) {
      await offerReadySteeringAtTurnBoundary();
    }
    if (
      event.type === "tool_execution_end" &&
      event.toolName === "run_build123d" &&
      !event.isError &&
      (event.result as { details?: { gate?: { status?: unknown } } })?.details?.gate?.status === "passed"
    ) {
      gatePassedThisTurn = true;
    }
    if (
      event.type === "turn_end" &&
      event.message.role === "assistant" &&
      !event.message.errorMessage &&
      !cadRunLimitReached &&
      Array.isArray(event.message.content) &&
      !event.message.content.some((block) => (block as { type?: string })?.type === "toolCall") &&
      !agent.hasQueuedMessages()
    ) {
      await persistQueue;
      // The agent would stop here. Inject at most one follow-up (pi drains the
      // follow-up queue only when the agent would otherwise end the run).
      // Both environments enforce the plan stop-gate: a Fusion build that quietly
      // stops mid-part is exactly as unfinished as a local one. Assembly evidence
      // is a run_build123d concept and stays local-only.
      const activePlan = latestPlan(agent.state.messages);
      const incomplete = activePlan ? planIncompleteComponents(activePlan) : [];
      const missingAssembly =
        cadEnvironment === "build123d" &&
        activePlan !== undefined &&
        incomplete.length === 0 &&
        !hasAssemblyEvidence(activePlan, agent.state.messages);
      const activeReferences = referenceRecords.filter((record) => record.status === "active" || record.status === "complementary");
      const evidence = currentVisualEvidence(opts.conversationId, agent.state.messages, referenceRecords);
      const visualResult = evidence
        ? validateVisualFinalization(evidence, latestVisualVerification)
        : activeReferences.length > 0
          ? { ok: false as const, reason: "missing-verification" as const, nudge: `Visual finalization is blocked. No current gate-passed artifact and inspection sheet cover active references: ${activeReferences.map((record) => record.referenceId).join(", ")}. ${
              cadEnvironment === "fusion"
                ? "Capture current evidence read-only: call inspect_fusion with a visual-evidence check (no mutation needed), then the visual verification batch protocol continues from that sheet."
                : "Re-run the current script with run_build123d to produce a gate-passed inspection sheet, then record the visual verification."
            }` }
          : { ok: true as const };
      const batchPlan = evidence ? planVisualVerificationBatches(evidence, model as Model<Api> & { maxInputImages?: number }, referenceRecords) : undefined;
      const batchProgress = batchPlan && batchPlan.batches.length > 0
        ? reconcileVisualVerificationBatches(batchPlan, visualVerificationBatches)
        : undefined;
      // A mid-flight deterministic visual-verification batch outranks the plan
      // nudge in both environments: current evidence exists and the next batch
      // is the required next step. In an image-driven flow the component cannot
      // become done until visual finalization records its form evidence, so
      // nudging "finish the plan" first starves the batch protocol (it only
      // continues through this injected follow-up).
      const pendingVisualBatch = !visualResult.ok && batchProgress?.status === "pending" && batchPlan;
      const newlyBlocked = (activePlan?.components ?? []).filter((component) =>
        component.status === "blocked" && !blockedAtSendStart.has(component.id) && !challengedBlockedComponents.has(component.id));
      if (pendingVisualBatch && !visualNudgedWithoutProgress) {
        visualNudgedWithoutProgress = true;
        projectedVisualBatchPlan = batchPlan;
        agent.followUp({
          role: "user",
          content: [{ type: "text", text: `${VISUAL_NUDGE_MARKER} Complete deterministic visual verification batch ${batchProgress.nextBatchIndex + 1}/${batchPlan.batches.length} for artifact ${batchPlan.artifactId} version ${batchPlan.artifactVersion} and sheet ${batchPlan.inspectionSheetId}. The next model request contains the exact shared sheet, reference subset, full active-set record, and carried observations.` }],
          timestamp: Date.now(),
        } as AgentMessage);
      } else if ((incomplete.length > 0 || missingAssembly) && planNudgesWithoutRun < MAX_PLAN_NUDGES_WITHOUT_RUN) {
        // Deterministic stop-gate: the plan of record says work remains - either
        // unfinished components, or interfaces nobody has measured because no
        // gate-passed run declared all components together. Bounded: the budget
        // renews on every CAD run, so only an agent that stops repeatedly without
        // doing anything exhausts it.
        planNudgesWithoutRun += 1;
        const text =
          incomplete.length > 0
            ? planNudgesWithoutRun > 1
              ? buildPlanContinuePrompt(incomplete)
              : cadEnvironment === "fusion"
                ? buildFusionPlanNudgePrompt(incomplete)
                : buildPlanNudgePrompt(incomplete)
            : `${PLAN_NUDGE_MARKER} Every component is done, but the interfaces are unverified: no gate-passed run has declared ALL components together. Build the assembly script (COMPONENT lists every component, Compound children labeled, interface clearance checks included) and run it before finishing.`;
        agent.followUp({
          role: "user",
          content: [{ type: "text", text }],
          timestamp: Date.now(),
        } as AgentMessage);
      } else if (incomplete.length > 0 || missingAssembly) {
        lastError = {
          kind: "generic",
          message:
            "Stopped with unfinished plan work after the agent ignored the plan check. Continue the conversation to resume the build.",
        };
      } else if (newlyBlocked.length > 0) {
        // Components marked blocked during this send get exactly one challenge -
        // the automated form of the human "continue" that repeatedly revived
        // falsely-blocked builds. A reaffirmed block afterwards is accepted
        // without pressure or error.
        for (const component of newlyBlocked) challengedBlockedComponents.add(component.id);
        agent.followUp({
          role: "user",
          content: [{ type: "text", text: buildBlockedChallengePrompt(newlyBlocked, cadEnvironment) }],
          timestamp: Date.now(),
        } as AgentMessage);
      } else if (!visualResult.ok && batchPlan?.unsupportedReason) {
        lastError = { kind: "generic", message: `Visual finalization cannot be batched safely: ${batchPlan.unsupportedReason}` };
      } else if (!visualResult.ok && batchProgress?.status === "invalid") {
        lastError = { kind: "generic", message: `Visual verification batch ledger is invalid: ${batchProgress.reason}` };
      } else if (!visualResult.ok && !visualNudgedWithoutProgress) {
        // The pending-batch case is handled above with priority; this branch
        // covers the remaining not-ok reasons (e.g. missing verification).
        visualNudgedWithoutProgress = true;
        agent.followUp({
          role: "user",
          content: [{ type: "text", text: `${VISUAL_NUDGE_MARKER} ${visualResult.nudge}` }],
          timestamp: Date.now(),
        } as AgentMessage);
      } else if (!visualResult.ok) {
        lastError = { kind: "generic", message: "Stopped without satisfying the visual finalization check. Continue to inspect or revise the current evidence." };
      } else if (incomplete.length === 0 && !missingAssembly && selfCheckArmed && gatePassedThisTurn) {
        selfCheckArmed = false;
        agent.followUp({
          role: "user",
          content: [{ type: "text", text: SELF_CHECK_PROMPT }],
          timestamp: Date.now(),
        } as AgentMessage);
      }
    }
    if (event.type === "message_end") {
      const reportInput = proofReportInputForCurrentEvidence(
        event.message,
        agent.state.messages,
        latestPlan(agent.state.messages),
        currentProofContract(proofContracts, latestPlan(agent.state.messages), referenceRegistrations),
        latestVisualVerification,
      );
      const seq = nextSeq;
      nextSeq += 1;
      queuePersist(seq, event.message);
      if (reportInput) {
        await persistQueue;
        try {
          const report = await rest.createProofReport(
            opts.conversationId,
            reportInput,
            `proof-report:${reportInput.engineeringEvidenceId}`,
          );
          proofReports = [
            ...proofReports
              .filter((candidate) => candidate.reportId !== report.reportId)
              .map((candidate) => ({ ...candidate, status: "stale" as const })),
            report,
          ];
          notify();
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          lastError = { kind: "generic", message: `proof-report-unavailable: ${reason}` };
        }
      }
      const steeringId = steeringIds.get(event.message);
      const steeringEntry = steeringId ? steeringEntries.get(steeringId) : undefined;
      if (steeringId && steeringEntry) {
        await persistQueue;
        steeringEntries.delete(steeringId);
        steeringEntry.resolve("consumed");
      }
    }
    if (
      event.type === "turn_end" &&
      event.message.role === "assistant" &&
      event.message.errorMessage &&
      event.message.stopReason !== "aborted" &&
      !cadRunLimitReached
    ) {
      // LLM/proxy failures arrive here: pi turns both in-band proxy error events and
      // streamFn rejections into an errored assistant message carrying errorMessage.
      // Aborted turns are excluded: the user asked for the stop (Stop button,
      // conversation switch), so the fabricated abort message is not an error.
      lastError = classifySessionError(event.message.errorMessage);
    }
    if (event.type === "agent_start") {
      lastError = undefined;
    }
    if (event.type === "agent_end") {
      // A provider error or a final steering-poll race can end the run with pi
      // queue entries still present. They belong to this run and must never leak
      // into a later prompt; callers retain cancelled entries for explicit replay.
      cancelPendingSteering();
    }
    if (event.type === "tool_execution_end" && (event.toolName === "run_build123d" || event.toolName === "run_fusion_action") && !event.isError) {
      productiveRunsThisWindow += 1;
    }
    if (event.type === "tool_execution_start" && (event.toolName === "run_build123d" || event.toolName === "run_fusion_action")) {
      cadRunsThisTurn += 1;
      planNudgesWithoutRun = 0;
      visualNudgedWithoutProgress = false;
      projectedVisualBatchPlan = undefined;
      const activePlan = latestPlan(agent.state.messages);
      const ceiling = PLAN_BUDGET_CEILING_FACTOR * maxCadRuns;
      if (event.toolName === "run_fusion_action") {
        // A Fusion action is one small feature-level change, and a normal part
        // takes 10-25 of them (base, each boss/hole/pocket/pattern, fillet,
        // chamfer, material, appearance) plus repairs. The per-component bucket
        // sized for whole-part build123d runs would abort a routine part
        // mid-build, so Fusion persistence is bounded by the turn ceiling only.
        if (cadRunsThisTurn > ceiling) {
          cadRunLimitReached = true;
          lastError = { kind: "generic", message: `Stopped after ${ceiling} Fusion actions in one turn (ceiling of ${PLAN_BUDGET_CEILING_FACTOR}x ${maxCadRuns}).` };
          agent.abort();
        }
      } else if (activePlan) {
        // Per-component budget under a global ceiling. Probe runs are diagnostics:
        // they drain only the ceiling, never a component bucket.
        const declaration = parseComponentDeclaration(
          typeof (event.args as { code?: unknown })?.code === "string" ? (event.args as { code: string }).code : "",
        );
        const isProbe = declaration?.length === 1 && declaration[0] === PROBE_COMPONENT;
        let exceeded: string | undefined;
        if (cadRunsThisTurn > ceiling) {
          exceeded = `Stopped after ${ceiling} CAD runs in one turn (plan ceiling of ${PLAN_BUDGET_CEILING_FACTOR}x ${maxCadRuns}).`;
        } else if (!isProbe) {
          const bucket = runBudgetBucket(declaration);
          const used = (cadRunsByBucket.get(bucket) ?? 0) + 1;
          cadRunsByBucket.set(bucket, used);
          if (used > maxCadRuns) {
            exceeded = `Stopped after ${maxCadRuns} CAD runs for plan component "${bucket}" in one turn.`;
          }
        }
        if (exceeded) {
          cadRunLimitReached = true;
          lastError = { kind: "generic", message: exceeded };
          agent.abort();
        }
      } else if (cadRunsThisTurn > maxCadRuns) {
        cadRunLimitReached = true;
        lastError = { kind: "generic", message: `Stopped after ${maxCadRuns} CAD runs in one turn.` };
        agent.abort();
      }
    }
    notify();
  });

  return {
    conversationId: opts.conversationId,
    async send(text: string, images?: File[]): Promise<void> {
      abortRequested = false;
      cadRunsThisTurn = 0;
      cadRunLimitReached = false;
      gatePassedThisTurn = false;
      selfCheckArmed = true;
      cadRunsByBucket.clear();
      planNudgesWithoutRun = 0;
      visualNudgedWithoutProgress = false;
      productiveRunsThisWindow = 0;
      challengedBlockedComponents.clear();
      blockedAtSendStart = new Set(
        (latestPlan(agent.state.messages)?.components ?? [])
          .filter((component) => component.status === "blocked")
          .map((component) => component.id),
      );
      imagePlanRequiredThisTurn = Boolean(images?.length);
      imagePlanRequiredAtSend = imagePlanRequiredThisTurn;
      consumedSteeringImagePlanRequired = false;
      imagePlanAcceptedThisTurn = false;
      lastRunStopReason = undefined;
      const identity = await configurationIdentity.catch(() => undefined);
      const reporter = identity
        ? new AgentRunReporter({
            conversationId: opts.conversationId,
            configuration: identity,
            evaluation: opts.evaluationIdentity,
          })
        : undefined;
      activeRunReporter = reporter;
      await reporter?.start();
      // Compaction runs between turns, before the prompt, and again between
      // auto-continued windows: when the LLM-visible context is near the window,
      // older history is summarized into a persisted compaction row. Failures are
      // non-fatal - the turn proceeds on the uncompacted context. Returns whether
      // a compaction row was produced (the overflow-recovery branch needs to know).
      const compactIfNeeded = async (force = false): Promise<boolean> => {
        let compactionOperation: { id: string; startedAt: number } | undefined;
        try {
          const row = await runCompaction({
            messages: agent.state.messages as AgentMessage[],
            model,
            streamFn,
            force,
            ...(cadEnvironment === "fusion" ? { projectMessages: projectFusionModelContext } : {}),
            onStart: () => {
              compactionOperation = { id: crypto.randomUUID(), startedAt: Date.now() };
              void reporter?.operationStarted("compaction", compactionOperation.id);
              notice = { kind: "compacting" };
              notify();
            },
          });
          if (row) {
            if (compactionOperation) {
              reporter?.operationCompleted("compaction", compactionOperation.id, "ok", Math.max(0, Date.now() - compactionOperation.startedAt));
              compactionOperation = undefined;
            }
            agent.state.messages = [...agent.state.messages, row as unknown as AgentMessage];
            const seq = nextSeq;
            nextSeq += 1;
            queuePersist(seq, row as unknown as AgentMessage);
            return true;
          }
        } catch (compactionError) {
          if (compactionOperation) {
            reporter?.operationCompleted("compaction", compactionOperation.id, "error", Math.max(0, Date.now() - compactionOperation.startedAt));
            compactionOperation = undefined;
          }
          console.warn("Chamfer: context compaction skipped:", compactionError);
        } finally {
          if (notice?.kind === "compacting") notice = undefined;
          notify();
        }
        return false;
      };
      await compactIfNeeded();
      try {
        if (abortRequested) {
          lastRunStopReason = "aborted";
          return;
        }
        // pi receives native image blocks for the live request. The message_end
        // persistence path stores ordered attachment references instead.
        const imageBlocks = images && images.length > 0
          ? await Promise.all(images.map(fileToImageContent))
          : [];
        imageBlocks.forEach((block) => {
          const id = crypto.randomUUID();
          imageReferenceIds.set(block, id);
          pendingThisTurn.add(id);
        });
        if (abortRequested) {
          lastRunStopReason = "aborted";
          return;
        }
        // agent.prompt()/continue() REJECT when the run ends on an errored turn, so
        // each run is awaited through this wrapper: the rejection becomes lastError
        // (pi has already persisted the errored assistant message) and control
        // returns to the continuation loop instead of aborting the whole send.
        const runToCompletion = async (run: () => Promise<void>) => {
          try {
            await run();
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            lastError = classifySessionError(reason);
          }
        };
        await runToCompletion(() => agent.prompt(text, imageBlocks.length > 0 ? imageBlocks : undefined));
        // Autonomous continuation: keep this send() alive until the work is done,
        // a genuine limitation is confirmed, budgets stop making progress, or the
        // user aborts. Two resumable endings:
        //  - a transient provider failure (rate limit, network, 5xx): back off and
        //    agent.continue() from the errored context, the documented retry path;
        //  - the per-turn CAD budget aborted a productive build mid-part: renew the
        //    window and re-prompt with a continuation order (the automated form of
        //    the human "continue"), bounded by MAX_BUDGET_CONTINUES windows that
        //    each must have completed at least one CAD run.
        const sleepFn = opts.__autoResumeOptions?.sleep
          ?? opts.__retryOptions?.sleep
          ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
        const waitUnlessAborted = async (ms: number) => {
          const slice = 500;
          for (let waited = 0; waited < ms && !abortRequested; waited += slice) {
            await sleepFn(Math.min(slice, ms - waited));
          }
        };
        const maxErrorResumes = opts.__autoResumeOptions?.maxErrorResumes ?? MAX_ERROR_RESUMES;
        const maxBudgetContinues = opts.__autoResumeOptions?.maxBudgetContinues ?? MAX_BUDGET_CONTINUES;
        const maxOverflowCompactions = opts.__autoResumeOptions?.maxOverflowCompactions ?? MAX_OVERFLOW_COMPACTIONS;
        const planStillIncomplete = () => {
          const plan = latestPlan(agent.state.messages);
          return plan ? planIncompleteComponents(plan).length > 0 : false;
        };
        let errorResumes = 0;
        let budgetContinues = 0;
        let overflowCompactions = 0;
        while (!abortRequested) {
          // A context overflow is recoverable exactly once per compaction: summarize
          // older history into a compaction row, then continue. Without this, a long
          // autonomous build dies at the finish line and even a manual follow-up
          // prompt inherits the oversized context (the observed terminal failure).
          if (lastRunStopReason !== "stop" && lastError?.kind === "context-overflow" && overflowCompactions < maxOverflowCompactions) {
            overflowCompactions += 1;
            const attempt = overflowCompactions;
            if (!(await compactIfNeeded(true))) break;
            lastError = undefined;
            lastRunStopReason = undefined;
            notify();
            agent.followUp({
              role: "user",
              content: [{ type: "text", text: `${PLAN_NUDGE_MARKER} The model context exceeded the window and older history was summarized (compaction ${attempt}/${maxOverflowCompactions}). Continue exactly where you left off.` }],
              timestamp: Date.now(),
            } as AgentMessage);
            await runToCompletion(() => agent.continue());
            continue;
          }
          // A resumable ending is a run that did NOT stop cleanly (errored turn, or a
          // rejected prompt that never reached turn_end) with a transient failure.
          if (lastRunStopReason !== "stop" && lastError && isResumableSessionError(lastError) && errorResumes < maxErrorResumes) {
            errorResumes += 1;
            // Same schedule as the stream-level retry: server retry-after hint
            // when present, else capped exponential backoff with jitter.
            const delayMs = retryDelayMs(lastError.message, errorResumes, ERROR_RESUME_BASE_DELAY_MS, ERROR_RESUME_MAX_DELAY_MS);
            notice = { kind: "retrying", attempt: errorResumes, maxAttempts: maxErrorResumes, delaySeconds: Math.ceil(delayMs / 1000) };
            notify();
            await waitUnlessAborted(delayMs);
            notice = undefined;
            if (abortRequested) break;
            const failedAttempt = errorResumes;
            lastError = undefined;
            lastRunStopReason = undefined;
            notify();
            // continue() refuses a context ending on the errored assistant message,
            // but drains the follow-up queue first - so the resume rides a durable
            // marker message that also records the recovery in the transcript.
            agent.followUp({
              role: "user",
              content: [{ type: "text", text: `${PLAN_NUDGE_MARKER} A transient provider failure interrupted the run (resume ${failedAttempt}/${maxErrorResumes}). Continue exactly where you left off.` }],
              timestamp: Date.now(),
            } as AgentMessage);
            await runToCompletion(() => agent.continue());
            continue;
          }
          if (cadRunLimitReached && budgetContinues < maxBudgetContinues && productiveRunsThisWindow > 0 && planStillIncomplete()) {
            budgetContinues += 1;
            // A clean turn resets the error-resume budget: outages separated by
            // productive work each get the full backoff ladder.
            errorResumes = 0;
            cadRunsThisTurn = 0;
            cadRunLimitReached = false;
            cadRunsByBucket.clear();
            productiveRunsThisWindow = 0;
            planNudgesWithoutRun = 0;
            lastError = undefined;
            lastRunStopReason = undefined;
            notify();
            // A window boundary is the safe moment to compact: a renewed budget
            // means a long build is still going, exactly when context pressure grows.
            await compactIfNeeded();
            await runToCompletion(() => agent.prompt(
              `${PLAN_NUDGE_MARKER} Budget window ${budgetContinues}/${maxBudgetContinues} renewed; the per-turn CAD run budget was reached, not the work. Continue the build from the current plan state with the next concrete tool action.`,
            ));
            continue;
          }
          break;
        }
      } catch (error) {
        // agent.prompt() can throw synchronously (e.g. "Agent is already processing a
        // prompt" when a send() overlaps an in-flight one) or reject. Either way this must
        // resolve normally so callers never see an unhandled rejection from an overlapping
        // send; the failure is surfaced via state.error instead. Classification keeps
        // overlapping-send text generic while still catching any auth/rate-limit text
        // from a rejection that escapes agent.prompt().
        const reason = error instanceof Error ? error.message : String(error);
        lastError = classifySessionError(reason);
      } finally {
        // Wait for any in-flight persistence (including its retry) to settle so that by the
        // time send() resolves, state.error reflects persistence failures from this turn too.
        await persistQueue;
        const outcome = cadRunLimitReached || lastError
          ? "failed"
          : lastRunStopReason === "aborted"
            ? "aborted"
            : "completed";
        await reporter?.finish(outcome);
        if (activeRunReporter === reporter) activeRunReporter = undefined;
        // agent.prompt() resolves after finishRun() clears isStreaming, which happens
        // after agent_end listeners settle, so subscribers need one more notification
        // to see the final, non-streaming state.
        notify();
      }
    },
    steer(id: string, text: string, images?: File[]): Promise<"consumed" | "cancelled"> {
      const existing = steeringEntries.get(id);
      if (existing) return existing.promise;
      let resolveEntry!: (outcome: "consumed" | "cancelled") => void;
      let resolveReady!: () => void;
      const promise = new Promise<"consumed" | "cancelled">((resolve) => {
        resolveEntry = resolve;
      });
      const ready = new Promise<void>((resolve) => {
        resolveReady = resolve;
      });
      const entry: SteeringEntry = {
        status: "preparing",
        attachmentIds: [],
        ready,
        resolveReady,
        resolve: resolveEntry,
        promise,
      };
      steeringEntries.set(id, entry);
      void (async () => {
        try {
          const imageBlocks = images && images.length > 0
            ? await Promise.all(images.map(fileToImageContent))
            : [];
          if (steeringEntries.get(id) !== entry || !agent.state.isStreaming) {
            if (steeringEntries.delete(id)) {
              entry.resolveReady();
              entry.resolve("cancelled");
            }
            return;
          }
          entry.attachmentIds = imageBlocks.map((block) => {
            const attachmentId = crypto.randomUUID();
            imageReferenceIds.set(block, attachmentId);
            return attachmentId;
          });
          entry.message = {
            role: "user",
            content: [{ type: "text", text }, ...imageBlocks],
            timestamp: Date.now(),
          } as AgentMessage;
          steeringIds.set(entry.message, id);
          entry.status = "ready";
          entry.resolveReady();
        } catch {
          if (steeringEntries.delete(id)) {
            entry.resolveReady();
            entry.resolve("cancelled");
          }
        }
      })();
      return promise;
    },
    cancelSteering(id: string): void {
      const entry = steeringEntries.get(id);
      if (!entry || entry.status === "consuming") return;
      steeringEntries.delete(id);
      removeSteeringGateState(entry);
      entry.resolveReady();
      entry.resolve("cancelled");
      if (entry.status === "offered") rebuildOfferedSteeringQueue();
    },
    prioritizeSteering(id: string): void {
      const chosen = steeringEntries.get(id);
      if (!chosen || chosen.status === "consuming") return;
      steeringEntries.delete(id);
      const ordered = [[id, chosen] as const, ...steeringEntries.entries()];
      steeringEntries.clear();
      for (const [entryId, entry] of ordered) steeringEntries.set(entryId, entry);
      if (chosen.status === "offered") rebuildOfferedSteeringQueue();
    },
    abort(): void {
      // Stop invalidates both user steering and autonomous plan/visual/self-check
      // continuations associated with this run. ChatState retains cancelled user
      // entries in its explicit paused queue.
      agent.clearAllQueues();
      abortRequested = true;
      cancelPendingSteering();
      agent.abort();
    },
    subscribe(listener: (state: SessionState) => void): () => void {
      listeners.add(listener);
      listener(snapshotState(
        agent,
        referenceRecords,
        sourceSpecifications,
        proofContracts,
        proofReports,
        designEscalations,
        referenceRegistrations,
        lastError,
        notice,
      ));
      return () => listeners.delete(listener);
    },
  };
}
