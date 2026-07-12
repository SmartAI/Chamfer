import { Agent, streamProxy, type AgentEvent, type AgentMessage, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import type { Model, Api, ImageContent } from "@earendil-works/pi-ai";
import { PROXY_AUTH_TOKEN } from "@chamfer/shared";
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

export interface ChatSession {
  conversationId: string;
  /**
   * Runs one agent.prompt() turn. `images` are embedded in the pi user message as image
   * content blocks (after the text block) and also uploaded as `user-image` attachments
   * tied to the persisted user message.
   */
  send(text: string, images?: File[]): Promise<void>;
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

/** With an active plan, the per-turn ceiling is this multiple of maxCadRuns; each
 * component bucket individually stays within maxCadRuns. */
export const PLAN_BUDGET_CEILING_FACTOR = 3;

export const IMAGE_PLAN_GATE_ERROR =
  "run_build123d is blocked for this image-triggered design request. Call update_plan first with a valid plan. The plan must include the goal, components with acceptance checks, interfaces, and a spec sheet in your own words that enumerates every readable dimension, feature, and spec-table row from the image. Each spec-sheet row must use non-empty check_refs that resolve to component checks, or a non-empty unverifiable_reason.";

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

function base64ToBytes(data: string): Uint8Array<ArrayBuffer> {
  const binary = atob(data);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
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

/** Builds a SessionState snapshot from current agent state, including the live streaming partial. */
function snapshotState(agent: Agent, error: SessionError | undefined, notice: SessionNotice | undefined): SessionState {
  const messages: unknown[] = agent.state.messages.slice();
  if (agent.state.isStreaming && agent.state.streamingMessage) {
    messages.push(agent.state.streamingMessage);
  }
  return { messages, streaming: agent.state.isStreaming, error, notice };
}

export function createSession(opts: CreateSessionOptions): ChatSession {
  const model = JSON.parse(opts.modelJson) as Model<Api>;
  const priorMessages = opts.priorMessages as AgentMessage[];

  let lastError: SessionError | undefined;
  let notice: SessionNotice | undefined;
  const listeners = new Set<(state: SessionState) => void>();

  // Pre-content 429/529 failures are retried inside the stream function, invisibly to
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

  const agent = new Agent({
    initialState: {
      systemPrompt: opts.systemPrompt,
      model,
      tools: [...((opts.tools ?? []) as AgentTool[]), planTool, ...skillTools],
    },
    streamFn,
    beforeToolCall: async ({ toolCall }) => {
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
    transformContext: async (messages) => transformLlmContext(messages),
  });
  agentForPlanTool = agent;
  agent.state.messages = priorMessages;

  let nextSeq = priorMessages.length;

  function notify(): void {
    const state = snapshotState(agent, lastError, notice);
    for (const listener of listeners) listener(state);
  }

  // Persistence must never throw back into the agent loop: a rejection escaping this
  // listener is caught by pi's runWithLifecycle and routed into handleRunFailure, which
  // fabricates a synthetic error assistant message and persists that instead of (or after)
  // the real one, permanently corrupting the seq sequence. A sequential promise-chain queue
  // keeps persistence ordered without ever letting a failure surface to the caller: each
  // message gets one retry, and a final failure records state.error but still consumes its
  // seq slot (the gap is documented via the error, not left dangling).
  let persistQueue: Promise<void> = Promise.resolve();

  /**
   * Uploads binary attachments for a persisted message: the view sheet for run_build123d
   * tool results, and user-image attachments for image blocks in user messages. The image
   * base64 also lives verbatim in the persisted contentJson (replay renders from there);
   * the attachment rows exist so the raw bytes stay addressable via REST.
   */
  async function uploadMessageAttachments(messageId: string, message: AgentMessage): Promise<void> {
    if (message.role === "toolResult" && message.toolName === "run_build123d") {
      const image = message.content.find((block) => block.type === "image");
      if (!image) return;
      await rest.uploadAttachment(messageId, "view-sheet", image.mimeType, base64ToBytes(image.data));
      return;
    }
    if (message.role === "user" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block.type === "image") {
          await rest.uploadAttachment(messageId, "user-image", block.mimeType, base64ToBytes(block.data));
        }
      }
    }
  }

  function queuePersist(seq: number, message: AgentMessage): void {
    const messageId = crypto.randomUUID();
    registerMessagePersistenceId(message, messageId);
    persistQueue = persistQueue.then(async () => {
      const payload = {
        id: messageId,
        seq,
        role: message.role,
        contentJson: JSON.stringify(message),
      };
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
      if (persisted) {
        try {
          await uploadMessageAttachments(payload.id, message);
        } catch (attachmentError) {
          const reason = attachmentError instanceof Error ? attachmentError.message : String(attachmentError);
          lastError = { kind: "generic", message: `attachment-persist-failed: ${reason}` };
          notify();
        }
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

  agent.subscribe((event: AgentEvent) => {
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
      // The agent would stop here. Inject at most one follow-up (pi drains the
      // follow-up queue only when the agent would otherwise end the run).
      const activePlan = latestPlan(agent.state.messages);
      const incomplete = activePlan ? planIncompleteComponents(activePlan) : [];
      const missingAssembly =
        activePlan !== undefined &&
        incomplete.length === 0 &&
        !hasAssemblyEvidence(activePlan, agent.state.messages);
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
    if (event.type === "tool_execution_start" && event.toolName === "run_build123d") {
      cadRunsThisTurn += 1;
      planNudgedWithoutRun = false;
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
      imagePlanRequiredThisTurn = Boolean(images?.length);
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
        // agent.prompt(text, imageBlocks) builds the user message with the text block
        // first, then the image blocks; message_end then persists it verbatim (base64
        // included) and uploadMessageAttachments mirrors the images to the REST store.
        const imageBlocks =
          images && images.length > 0 ? await Promise.all(images.map(fileToImageContent)) : undefined;
        await agent.prompt(text, imageBlocks);
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
    abort(): void {
      agent.abort();
    },
    subscribe(listener: (state: SessionState) => void): () => void {
      listeners.add(listener);
      listener(snapshotState(agent, lastError, notice));
      return () => listeners.delete(listener);
    },
  };
}
