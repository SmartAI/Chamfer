import { Agent, streamProxy, type AgentEvent, type AgentMessage, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import type { Model, Api, ImageContent } from "@earendil-works/pi-ai";
import { PROXY_AUTH_TOKEN } from "@chamfer/shared";
import * as rest from "../api/rest";

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

export interface SessionState {
  /** pi AgentMessages: persisted history plus the live streaming partial, if any. */
  messages: unknown[];
  streaming: boolean;
  error?: SessionError;
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
  /** Replayed from REST: parsed AgentMessage history for this conversation. */
  priorMessages: unknown[];
  /**
   * Internal test-only override for the stream function. Production callers must not set this;
   * it exists so tests can inject a fake streamFn without mocking the whole pi-agent-core module.
   */
  __streamFn?: StreamFn;
}

function buildStreamFn(): StreamFn {
  return (model, context, options) =>
    streamProxy(model, context, {
      ...options,
      authToken: PROXY_AUTH_TOKEN,
      proxyUrl: window.location.origin,
    });
}

const PERSIST_RETRY_DELAY_MS = 250;
const MAX_CAD_RUNS_PER_TURN = 10;
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
function snapshotState(agent: Agent, error: SessionError | undefined): SessionState {
  const messages: unknown[] = agent.state.messages.slice();
  if (agent.state.isStreaming && agent.state.streamingMessage) {
    messages.push(agent.state.streamingMessage);
  }
  return { messages, streaming: agent.state.isStreaming, error };
}

export function createSession(opts: CreateSessionOptions): ChatSession {
  const model = JSON.parse(opts.modelJson) as Model<Api>;
  const priorMessages = opts.priorMessages as AgentMessage[];

  const agent = new Agent({
    initialState: {
      systemPrompt: opts.systemPrompt,
      model,
      tools: (opts.tools ?? []) as AgentTool[],
    },
    streamFn: opts.__streamFn ?? buildStreamFn(),
  });
  agent.state.messages = priorMessages;

  let nextSeq = priorMessages.length;
  let lastError: SessionError | undefined;
  const listeners = new Set<(state: SessionState) => void>();

  function notify(): void {
    const state = snapshotState(agent, lastError);
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

  let cadRunsThisTurn = 0;
  let cadRunLimitReached = false;

  agent.subscribe((event: AgentEvent) => {
    if (event.type === "message_end") {
      const seq = nextSeq;
      nextSeq += 1;
      queuePersist(seq, event.message);
    }
    if (
      event.type === "turn_end" &&
      event.message.role === "assistant" &&
      event.message.errorMessage &&
      !cadRunLimitReached
    ) {
      // LLM/proxy failures arrive here: pi turns both in-band proxy error events and
      // streamFn rejections into an errored assistant message carrying errorMessage.
      lastError = classifySessionError(event.message.errorMessage);
    }
    if (event.type === "agent_start") {
      lastError = undefined;
    }
    if (event.type === "tool_execution_start" && event.toolName === "run_build123d") {
      cadRunsThisTurn += 1;
      if (cadRunsThisTurn > MAX_CAD_RUNS_PER_TURN) {
        cadRunLimitReached = true;
        lastError = { kind: "generic", message: `Stopped after ${MAX_CAD_RUNS_PER_TURN} CAD runs in one turn.` };
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
      listener(snapshotState(agent, lastError));
      return () => listeners.delete(listener);
    },
  };
}
