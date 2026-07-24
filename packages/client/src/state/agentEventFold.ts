import type { SessionError } from "@/components/ErrorBanner";
import type { AgentStreamEvent } from "@/api/agentTransport";

/** The tool currently executing server-side, for the in-progress affordance. */
export interface ActiveTool {
  name: string;
  /** Epoch ms; drives the elapsed display. */
  startedAt: number;
}

/** Chat-visible session state folded from persisted history plus the live
 * server-sent pi event stream. Messages are pi AgentMessage-shaped objects. */
export interface SessionState {
  messages: unknown[];
  /**
   * Turn status. Keys ONLY on agent_start / agent_settled, the agent_status
   * connect snapshot, and run-fatal agent_error - never on agent_end,
   * message_end, turn_end, stopReason, or stream silence: long tool calls
   * (Fusion executes) emit nothing for minutes while very much running, and
   * pi emits agent_end per internal run - a retry or overflow-compaction
   * continuation follows it with the turn still alive. agent_settled is pi's
   * once-per-prompt settlement signal.
   */
  streaming: boolean;
  /**
   * A prompt has been POSTed but no live event has come back yet. Set optimistically
   * by sendMessage and cleared by the first event that proves the turn is alive
   * (below). It exists because the hosted agent can take tens of seconds to answer
   * on a cold container start, and streaming stays false that whole time - without
   * it the UI shows nothing between click and first token, reading as a freeze.
   */
  submitting?: boolean;
  /**
   * Text of the just-sent prompt, rendered as an optimistic user bubble while
   * submitting. pi echoes the real user message back over the stream once the
   * turn starts, so this is cleared the instant any live content arrives - the
   * echoed bubble takes its place with no gap and no duplicate.
   */
  pendingPrompt?: string;
  activeTool?: ActiveTool;
  error?: SessionError;
  /** Whether the tail of `messages` is a live partial being streamed. Internal
   * to the fold: a message_update arriving without its message_start (SSE
   * reconnect mid-message) must append, not overwrite persisted history. */
  liveMessageOpen?: boolean;
  /** Terminal-error candidate read at the last agent_end. Internal to the
   * fold: surfaced only at agent_settled - a continuation's agent_start
   * discards it, because pi recovered (compact-and-retry) rather than died. */
  pendingError?: SessionError;
}

export const EMPTY_SESSION_STATE: SessionState = { messages: [], streaming: false };

// Provider failure text is free-form; classification is a best-effort text
// match that only changes which recovery affordance the banner offers.
const INVALID_KEY_PATTERN =
  /\b401\b|unauthorized|invalid[^.]{0,20}(api[ _-]?key|x-api-key)|authentication|api key|credit|billing/i;
const RATE_LIMIT_PATTERN = /\b429\b|rate[ _-]?limit|too many requests/i;

export function classifySessionError(message: string): SessionError {
  if (INVALID_KEY_PATTERN.test(message)) return { kind: "invalid-key", message };
  if (RATE_LIMIT_PATTERN.test(message)) return { kind: "rate-limited", message };
  return { kind: "generic", message };
}

interface RoledMessage {
  role?: unknown;
  stopReason?: unknown;
  errorMessage?: unknown;
}

/** Terminal failure carried by a run's final assistant message, if any.
 * Read at agent_end but surfaced only at agent_settled: a mid-run stopReason
 * "error" is retried by pi, and even a run-final error can be recovered by a
 * continuation (overflow compact-and-retry) - failure UI must wait for the
 * session to actually settle on it. */
function terminalError(messages: unknown): SessionError | undefined {
  if (!Array.isArray(messages)) return undefined;
  const assistant = [...messages].reverse().find(
    (message) => (message as RoledMessage)?.role === "assistant",
  ) as RoledMessage | undefined;
  if (!assistant || assistant.stopReason !== "error") return undefined;
  const detail = typeof assistant.errorMessage === "string" && assistant.errorMessage
    ? assistant.errorMessage
    : "The model request failed";
  return classifySessionError(detail);
}

function normalizeActiveTool(value: unknown): ActiveTool | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const tool = value as { name?: unknown; startedAt?: unknown };
  if (typeof tool.name !== "string" || !tool.name) return undefined;
  return { name: tool.name, startedAt: typeof tool.startedAt === "number" ? tool.startedAt : Date.now() };
}

/**
 * Folds one server-sent agent event into the session state. Pure so the
 * status rule is unit-testable: only agent_start, agent_settled, agent_status,
 * and agent_error may change `streaming`.
 */
export function applyAgentStreamEvent(state: SessionState, event: AgentStreamEvent): SessionState {
  switch (event.type) {
    case "agent_status":
      // Synthetic snapshot emitted by the server on every SSE (re)connect. A
      // running snapshot proves the turn is live and retires the optimistic
      // hint; an idle snapshot (the pre-turn connect state) leaves it untouched.
      return {
        ...state,
        streaming: event.running === true,
        ...(event.running === true ? { submitting: false, pendingPrompt: undefined } : {}),
        activeTool: event.running === true ? normalizeActiveTool(event.activeTool) : undefined,
      };
    case "agent_start":
      // Turn (or continuation) is live, but keep the optimistic bubble until the
      // first real content: pi echoes the user message a beat later, and dropping
      // it here would blink the prompt out and back in. Whatever the previous run
      // ended with is being recovered, so the held error candidate is stale.
      return { ...state, streaming: true, activeTool: undefined, error: undefined, pendingError: undefined };
    case "agent_end": {
      // One internal run is over, but the turn may continue (retry, overflow
      // compact-and-retry): only close out run-scoped state and remember the
      // error candidate for settlement.
      const error = event.willRetry === true ? undefined : terminalError(event.messages);
      return {
        ...state,
        submitting: false,
        pendingPrompt: undefined,
        activeTool: undefined,
        liveMessageOpen: false,
        pendingError: error,
      };
    }
    case "agent_settled":
      return {
        ...state,
        streaming: false,
        submitting: false,
        pendingPrompt: undefined,
        activeTool: undefined,
        liveMessageOpen: false,
        pendingError: undefined,
        ...(state.pendingError ? { error: state.pendingError } : {}),
      };
    case "agent_error":
      return {
        ...state,
        streaming: false,
        submitting: false,
        pendingPrompt: undefined,
        activeTool: undefined,
        error: classifySessionError(typeof event.message === "string" && event.message ? event.message : "Agent failed"),
      };
    case "tool_execution_start":
      return typeof event.toolName === "string"
        ? { ...state, submitting: false, pendingPrompt: undefined, activeTool: { name: event.toolName, startedAt: Date.now() } }
        : state;
    case "tool_execution_end":
      return { ...state, submitting: false, pendingPrompt: undefined, activeTool: undefined };
    case "message_start":
      // The first message is pi's echo of the just-sent prompt; clearing the
      // optimistic bubble here hands off to it seamlessly.
      return { ...state, submitting: false, pendingPrompt: undefined, messages: [...state.messages, event.message], liveMessageOpen: true };
    case "message_update":
    case "message_end": {
      const messages = state.liveMessageOpen === true
        ? [...state.messages.slice(0, -1), event.message]
        : [...state.messages, event.message];
      return { ...state, submitting: false, pendingPrompt: undefined, messages, liveMessageOpen: event.type !== "message_end" };
    }
    default:
      return state;
  }
}
