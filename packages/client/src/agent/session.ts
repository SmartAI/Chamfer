import { Agent, streamProxy, type AgentEvent, type AgentMessage, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import type { Model, Api, ImageContent, Message } from "@earendil-works/pi-ai";
import {
  PROXY_AUTH_TOKEN,
  type AttachmentReferenceBlock,
  type ReferenceClassificationDto,
  type ReferenceRecordDto,
  type InspectionLeaseDto,
  type VisualVerificationRecordDto,
  type VisualVerificationBatchRecordDto,
  type RecordVisualVerificationBatchInput,
} from "@chamfer/shared";
import * as rest from "../api/rest";
import { transformLlmContext } from "./contextPolicy";
import { runCompaction } from "./compaction";
import { withStreamRetry, type StreamRetryOptions } from "./retryStream";
import {
  PROBE_COMPONENT,
  hasAssemblyEvidence,
  latestPlan,
  parseComponentDeclaration,
  planIncompleteComponents,
  runBudgetBucket,
  validateRunChecksConformance,
} from "./plan";
import { createUpdatePlanTool } from "./tools/updatePlan";
import { createLoadSkillTool } from "./tools/loadSkill";
import { skillNudgeBlock } from "./skillNudge";
import { DEFAULT_SKILL_MODE, type Build123dSkillMode } from "./build123dSkill";
import { withInspectionSheetEvidence } from "./inspectionSheetLifecycle";
import { pendingReferenceIds, projectClassifiedReferences } from "./referenceClassification";
import { createClassifyReferenceTool } from "./tools/classifyReference";
import { createInspectEvidenceTool, createRecordInspectionObservationTool } from "./tools/inspectionEvidence";
import { projectInspectionLeases } from "./inspectionLeaseProjection";
import { createRecordVisualVerificationBatchTool } from "./tools/recordVisualVerificationBatch";
import { currentVisualEvidence, validateVisualFinalization } from "./visualVerification";
import { planVisualVerificationBatches, preferQueuedVisualBatchPlan, projectVisualVerificationBatch, reconcileVisualVerificationBatches, validateProjectedVisualBatchInput, type VisualVerificationBatchPlan } from "./visualVerificationBatching";

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

export type SessionErrorKind = "invalid-key" | "rate-limited" | "generic";

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

/** Maps a raw failure message to a SessionError {kind, message}. */
export function classifySessionError(message: string): SessionError {
  if (INVALID_KEY_PATTERN.test(message)) return { kind: "invalid-key", message };
  if (RATE_LIMIT_PATTERN.test(message)) return { kind: "rate-limited", message };
  return { kind: "generic", message };
}

export interface CreateSessionOptions {
  conversationId: string;
  modelJson: string;
  systemPrompt: string;
  /** AgentTool[]; empty in M2, filled in M4. */
  tools?: unknown[];
  /** Build123d skill treatment; load_skill is registered unless the ablation arm
   * ("none"/"core") predates the skill layer. Defaults to DEFAULT_SKILL_MODE. */
  skillMode?: Build123dSkillMode;
  /** Replayed from REST: parsed AgentMessage history for this conversation. */
  priorMessages: unknown[];
  /** Durable current reference state and append-only history loaded with the conversation. */
  referenceRecords?: ReferenceRecordDto[];
  /** Durable leases that were still open when the conversation was loaded. */
  openInspectionLeases?: InspectionLeaseDto[];
  /** Durable visual verdict history loaded with the conversation. */
  visualVerifications?: VisualVerificationRecordDto[];
  /** Durable partial visual batch ledger loaded with the conversation. */
  visualVerificationBatches?: VisualVerificationBatchRecordDto[];
  /** Max run_build123d executions per turn before the turn is aborted;
   * defaults to DEFAULT_MAX_CAD_RUNS. Configurable via settings/env. */
  maxCadRuns?: number;
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

/** Prefix identifying the injected self-check nudge, so the UI can render it as a
 * system chip and the rate-limit Retry action never resends it as the user's prompt. */
export const SELF_CHECK_MARKER = "[Chamfer self-check]";

export const SELF_CHECK_PROMPT = `${SELF_CHECK_MARKER} The verify gate passed for the current script. A passing gate only confirms the current geometry matches its own EXPECT block - it does not mean the whole request is done. For an image request, compare the latest inspection sheet against the reference image view by view: isometric, front, back, left, right, top, and bottom. Record a match or mismatch verdict and a concrete note for every view in form_review, tied by evidence_id to that latest gate-passed run. Fix any mismatch before marking the component done. For a text-only request, re-read the original request and check every requested part, feature, and step against the latest measurements and views. If anything is missing, continue building it now. If everything is satisfied, reply with the final summary.`;

/** Prefix identifying the deterministic plan stop-gate nudge (planned turns replace
 * the prose self-check with this; the UI renders it as a system chip). */
export const PLAN_NUDGE_MARKER = "[Chamfer plan check]";
export const VISUAL_NUDGE_MARKER = "[Chamfer visual check]";

/** With an active plan, the per-turn ceiling is this multiple of maxCadRuns; each
 * component bucket individually stays within maxCadRuns. */
export const PLAN_BUDGET_CEILING_FACTOR = 3;

export const IMAGE_PLAN_GATE_ERROR =
  "run_build123d is blocked for this image-triggered design request. Call update_plan first with a valid plan. The plan must include the goal, components with acceptance checks, interfaces, and a spec sheet in your own words that enumerates every readable dimension, feature, and spec-table row from the image. Each spec-sheet row must use non-empty check_refs that resolve to component checks, or a non-empty unverifiable_reason.";

export function referenceClassificationGateError(referenceIds: readonly string[]): string {
  return `run_build123d is blocked because reference images are unclassified: ${referenceIds.join(", ")}. Call classify_reference for each ID with status, purpose, relationships, rationale, and specificationLinks or noSpecificationReason.`;
}

export function buildPlanNudgePrompt(incomplete: readonly { id: string; status: string }[]): string {
  const list = incomplete.map((c) => `"${c.id}" (${c.status})`).join(", ");
  return `${PLAN_NUDGE_MARKER} The plan still has unfinished components: ${list}. A component only counts as done after a gate-passed run declares it via COMPONENT and passes its planned checks, and update_plan records it. For each unfinished component, either continue building it now, or mark it blocked with a non-empty blocked_reason that clearly states the genuine limitation. Weakening checks to force closure is never acceptable. Do not stop while the plan has unfinished components and budget remains.`;
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
  error: SessionError | undefined,
  notice: SessionNotice | undefined,
): SessionState {
  const messages: unknown[] = agent.state.messages.slice();
  if (agent.state.isStreaming && agent.state.streamingMessage) {
    messages.push(agent.state.streamingMessage);
  }
  return { messages, referenceRecords: [...referenceRecords], streaming: agent.state.isStreaming, error, notice };
}

export function createSession(opts: CreateSessionOptions): ChatSession {
  const model = JSON.parse(opts.modelJson) as Model<Api>;
  const priorMessages = opts.priorMessages as AgentMessage[];
  let referenceRecords = [...(opts.referenceRecords ?? [])];
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

  // update_plan and load_skill validate against the live transcript (latest plan +
  // gate evidence; already-loaded skill payloads), so they are session-owned: the
  // closures resolve to the agent created just below.
  let agentForPlanTool: Agent | undefined;
  const planTool = createUpdatePlanTool({
    getMessages: () => agentForPlanTool?.state.messages ?? [],
    requireSpecSheet: () => imagePlanRequiredThisTurn,
    onAccepted: () => {
      imagePlanAcceptedThisTurn = true;
    },
  }) as unknown as AgentTool;

  // The "none" and "core" ablation arms predate the skill layer and must not
  // expose it; "catalog" and "full" both register the tool ("full" keeps it so a
  // model that asks anyway gets the dedupe notice instead of an unknown-tool error).
  const skillMode = opts.skillMode ?? DEFAULT_SKILL_MODE;
  const skillTools: AgentTool[] =
    skillMode === "catalog" || skillMode === "full"
      ? [createLoadSkillTool({ getMessages: () => agentForPlanTool?.state.messages ?? [] }) as unknown as AgentTool]
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
      specificationLinks: classification.specificationLinks,
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

  const agent = new Agent({
    initialState: {
      systemPrompt: opts.systemPrompt,
      model,
      tools: [
        ...((opts.tools ?? []) as AgentTool[]),
        classificationTool,
        inspectEvidenceTool,
        recordObservationTool,
        visualVerificationBatchTool,
        planTool,
        ...skillTools,
      ],
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
      if (toolCall.name === "run_build123d") {
        const unclassified = new Set([
          ...pendingReferenceIds(agentForPlanTool?.state.messages ?? priorMessages, referenceRecords),
          ...pendingThisTurn,
        ]);
        if (unclassified.size > 0) {
          return { block: true, reason: referenceClassificationGateError([...unclassified]) };
        }
      }
      if (toolCall.name === "run_build123d" && imagePlanRequiredThisTurn && !imagePlanAcceptedThisTurn) {
        return { block: true, reason: IMAGE_PLAN_GATE_ERROR };
      }
      return undefined;
    },
    afterToolCall: async ({ toolCall, result, isError, context }) => {
      if (toolCall.name !== "run_build123d") return undefined;
      if (!isError) {
        const activePlan = latestPlan(context.messages);
        const measurements = (result.details as { measurements?: unknown } | undefined)?.measurements;
        if (activePlan && measurements && typeof measurements === "object") {
          const errors = validateRunChecksConformance(activePlan, measurements);
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
              details: result.details,
              isError: true,
            };
          }
        }
      }
      if (skillTools.length === 0) return undefined;
      const nudge = skillNudgeBlock(context.messages, result, isError);
      if (!nudge) return undefined;
      const content = Array.isArray(result.content) ? result.content : [];
      return { content: [...content, nudge] };
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
      const evidence = currentVisualEvidence(opts.conversationId, messages, referenceRecords);
      const limits = model as Model<Api> & { maxInputImages?: number };
      const currentBatchPlan = evidence?.activeReferenceIds.length
        ? planVisualVerificationBatches(evidence, limits, referenceRecords)
        : undefined;
      const batchPlan = preferQueuedVisualBatchPlan(currentBatchPlan, projectedVisualBatchPlan);
      if (!batchPlan) return projected;
      return projectVisualVerificationBatch(
        projected,
        messages,
        batchPlan,
        reconcileVisualVerificationBatches(batchPlan, visualVerificationBatches),
      );
    },
    convertToLlm: (messages) => materializeAttachmentReferences(messages, opts.__onImageExposure),
  });
  agentForPlanTool = agent;
  agent.state.messages = priorMessages;

  let nextSeq = priorMessages.length;

  function notify(): void {
    const state = snapshotState(agent, referenceRecords, lastError, notice);
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
    const kind = message.role === "user" ? "user-image" : message.toolName === "run_build123d" ? "view-sheet" : undefined;
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
        } catch (attachmentError) {
          const reason = attachmentError instanceof Error ? attachmentError.message : String(attachmentError);
          lastError = { kind: "generic", message: `attachment-persist-failed: ${reason}` };
          notify();
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
    });
  }

  const maxCadRuns =
    opts.maxCadRuns && Number.isInteger(opts.maxCadRuns) && opts.maxCadRuns > 0
      ? opts.maxCadRuns
      : DEFAULT_MAX_CAD_RUNS;
  let cadRunsThisTurn = 0;
  let cadRunLimitReached = false;
  // Self-check: armed once per send(); fires when the agent is about to stop after a
  // gate pass, nudging it to verify the WHOLE request is satisfied, not just the gate.
  let gatePassedThisTurn = false;
  let selfCheckArmed = false;
  // Plan enforcement. With an active plan the budget is per component bucket (the
  // COMPONENT declaration parsed from the script; probe runs drain only the global
  // ceiling), and stopping with unfinished components triggers one deterministic
  // follow-up. `planNudgedWithoutRun` guarantees a nudge is never injected twice
  // without an intervening run_build123d call.
  const cadRunsByBucket = new Map<string, number>();
  let planNudgedWithoutRun = false;
  let visualNudgedWithoutProgress = false;

  agent.subscribe(async (event: AgentEvent) => {
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
      const activePlan = latestPlan(agent.state.messages);
      const incomplete = activePlan ? planIncompleteComponents(activePlan) : [];
      const missingAssembly =
        activePlan !== undefined &&
        incomplete.length === 0 &&
        !hasAssemblyEvidence(activePlan, agent.state.messages);
      const activeReferences = referenceRecords.filter((record) => record.status === "active" || record.status === "complementary");
      const evidence = currentVisualEvidence(opts.conversationId, agent.state.messages, referenceRecords);
      const visualResult = evidence
        ? validateVisualFinalization(evidence, latestVisualVerification)
        : activeReferences.length > 0
          ? { ok: false as const, reason: "missing-verification" as const, nudge: `Visual finalization is blocked. No current gate-passed artifact and inspection sheet cover active references: ${activeReferences.map((record) => record.referenceId).join(", ")}.` }
          : { ok: true as const };
      const batchPlan = evidence ? planVisualVerificationBatches(evidence, model as Model<Api> & { maxInputImages?: number }, referenceRecords) : undefined;
      const batchProgress = batchPlan && batchPlan.batches.length > 0
        ? reconcileVisualVerificationBatches(batchPlan, visualVerificationBatches)
        : undefined;
      if ((incomplete.length > 0 || missingAssembly) && !planNudgedWithoutRun) {
        // Deterministic stop-gate: the plan of record says work remains - either
        // unfinished components, or interfaces nobody has measured because no
        // gate-passed run declared all components together. Never fires twice
        // without an intervening run_build123d call.
        planNudgedWithoutRun = true;
        const text =
          incomplete.length > 0
            ? buildPlanNudgePrompt(incomplete)
            : `${PLAN_NUDGE_MARKER} Every component is done, but the interfaces are unverified: no gate-passed run has declared ALL components together. Build the assembly script (COMPONENT lists every component, Compound children labeled, interface clearance checks included) and run it before finishing.`;
        agent.followUp({
          role: "user",
          content: [{ type: "text", text }],
          timestamp: Date.now(),
        } as AgentMessage);
      } else if ((incomplete.length > 0 || missingAssembly) && planNudgedWithoutRun) {
        lastError = {
          kind: "generic",
          message:
            "Stopped with unfinished plan work after the agent ignored the plan check. Continue the conversation to resume the build.",
        };
      } else if (!visualResult.ok && batchPlan?.unsupportedReason) {
        lastError = { kind: "generic", message: `Visual finalization cannot be batched safely: ${batchPlan.unsupportedReason}` };
      } else if (!visualResult.ok && batchProgress?.status === "invalid") {
        lastError = { kind: "generic", message: `Visual verification batch ledger is invalid: ${batchProgress.reason}` };
      } else if (!visualResult.ok && !visualNudgedWithoutProgress) {
        visualNudgedWithoutProgress = true;
        if (batchProgress?.status === "pending" && batchPlan) projectedVisualBatchPlan = batchPlan;
        const batchNudge = batchProgress?.status === "pending" && batchPlan
          ? `Complete deterministic visual verification batch ${batchProgress.nextBatchIndex + 1}/${batchPlan.batches.length} for artifact ${batchPlan.artifactId} version ${batchPlan.artifactVersion} and sheet ${batchPlan.inspectionSheetId}. The next model request contains the exact shared sheet, reference subset, full active-set record, and carried observations.`
          : visualResult.nudge;
        agent.followUp({
          role: "user",
          content: [{ type: "text", text: `${VISUAL_NUDGE_MARKER} ${batchNudge}` }],
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
      const seq = nextSeq;
      nextSeq += 1;
      queuePersist(seq, event.message);
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
    if (event.type === "tool_execution_start" && event.toolName === "run_build123d") {
      cadRunsThisTurn += 1;
      planNudgedWithoutRun = false;
      visualNudgedWithoutProgress = false;
      projectedVisualBatchPlan = undefined;
      const activePlan = latestPlan(agent.state.messages);
      if (activePlan) {
        // Per-component budget under a global ceiling. Probe runs are diagnostics:
        // they drain only the ceiling, never a component bucket.
        const declaration = parseComponentDeclaration(
          typeof (event.args as { code?: unknown })?.code === "string" ? (event.args as { code: string }).code : "",
        );
        const ceiling = PLAN_BUDGET_CEILING_FACTOR * maxCadRuns;
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
      cadRunsThisTurn = 0;
      cadRunLimitReached = false;
      gatePassedThisTurn = false;
      selfCheckArmed = true;
      cadRunsByBucket.clear();
      planNudgedWithoutRun = false;
      visualNudgedWithoutProgress = false;
      imagePlanRequiredThisTurn = Boolean(images?.length);
      imagePlanRequiredAtSend = imagePlanRequiredThisTurn;
      consumedSteeringImagePlanRequired = false;
      imagePlanAcceptedThisTurn = false;
      // Compaction runs between turns, before the prompt: when the LLM-visible context
      // is near the window, older history is summarized into a persisted compaction
      // row. Failures are non-fatal - the turn proceeds on the uncompacted context.
      try {
        const row = await runCompaction({
          messages: agent.state.messages as AgentMessage[],
          model,
          streamFn,
          onStart: () => {
            notice = { kind: "compacting" };
            notify();
          },
        });
        if (row) {
          agent.state.messages = [...agent.state.messages, row as unknown as AgentMessage];
          const seq = nextSeq;
          nextSeq += 1;
          queuePersist(seq, row as unknown as AgentMessage);
        }
      } catch (compactionError) {
        console.warn("Chamfer: context compaction skipped:", compactionError);
      } finally {
        if (notice?.kind === "compacting") notice = undefined;
        notify();
      }
      try {
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
        await agent.prompt(text, imageBlocks.length > 0 ? imageBlocks : undefined);
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
      cancelPendingSteering();
      agent.abort();
    },
    subscribe(listener: (state: SessionState) => void): () => void {
      listeners.add(listener);
      listener(snapshotState(agent, referenceRecords, lastError, notice));
      return () => listeners.delete(listener);
    },
  };
}
