import type { DatabaseSync } from "node:sqlite";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { createMessage, listMessages, maxMessageSeq } from "../conversationStore";
import { ConversationEventTooLargeError } from "../conversationEventStore";

/** Placeholder left in a message when an inline image is too large to persist
 * under the conversation-event byte cap. Real photos are downscaled on the
 * client to well under the cap, so this is a last-resort so the rest of the
 * turn - crucially the executed CAD code - still lands. */
const IMAGE_OMITTED_NOTE = "[image removed: exceeded the per-message storage limit]";

function isImageBlock(value: unknown): value is { type: "image" } {
  return (value as { type?: unknown })?.type === "image";
}

/** Returns a copy of the message with inline image blocks replaced by a short
 * text note, or the message unchanged when it carries no inline image. */
function stripInlineImages(message: unknown): unknown {
  const content = (message as { content?: unknown })?.content;
  if (!Array.isArray(content) || !content.some(isImageBlock)) return message;
  return {
    ...(message as object),
    content: content.map((block) => (isImageBlock(block) ? { type: "text", text: IMAGE_OMITTED_NOTE } : block)),
  };
}

/** Storage cap for one toolResult row's contentJson. Tool results are the only
 * unbounded transcript role (inspection dumps, screenshots-as-text can reach
 * many MB); assistant and user sizes are bounded by model context and are
 * stored verbatim. An over-cap result keeps its identity (toolCallId,
 * toolName, isError), its gate verdict (the lastGateStatus rollup reads it at
 * insert), and a text head - everything else is dropped. */
export const MAX_TOOL_RESULT_JSON_CHARS = 512_000;
const TRUNCATED_TEXT_HEAD_CHARS = 16_000;

function isTextBlock(value: unknown): value is { type: "text"; text: string } {
  const block = value as { type?: unknown; text?: unknown };
  return block?.type === "text" && typeof block.text === "string";
}

function roleOf(message: unknown): string {
  const role = (message as { role?: unknown })?.role;
  return typeof role === "string" ? role : "assistant";
}

function serializeForStore(message: unknown): string {
  const json = JSON.stringify(message);
  if (roleOf(message) !== "toolResult" || json.length <= MAX_TOOL_RESULT_JSON_CHARS) return json;
  const record = message as {
    toolCallId?: unknown;
    toolName?: unknown;
    isError?: unknown;
    content?: unknown;
    details?: { gate?: unknown };
  };
  const text = (Array.isArray(record.content) ? record.content : [])
    .filter(isTextBlock)
    .map((block) => block.text)
    .join("\n");
  return JSON.stringify({
    role: "toolResult",
    toolCallId: record.toolCallId,
    toolName: record.toolName,
    isError: record.isError,
    truncated: true,
    content: [{
      type: "text",
      text: `${text.slice(0, TRUNCATED_TEXT_HEAD_CHARS)}\n[tool result truncated for storage: ${json.length} chars]`,
    }],
    ...(record.details?.gate !== undefined ? { details: { gate: record.details.gate } } : {}),
  });
}

/** Appends messages to the conversation store in order, continuing the seq
 * sequence. Single writer per conversation: the pi session's event listener
 * and the prompt path run on the same loop against a synchronous store.
 *
 * Resilient per message: a single row that exceeds the conversation-event byte
 * cap (an oversized inline image) is stored with its images stripped rather
 * than aborting the whole turn. Before this, the user+image row - always first
 * in a turn - would throw and take the assistant reply and executed CAD code
 * down with it, leaving the conversation in the list but with no history. */
export function appendStoredMessages(db: DatabaseSync, conversationId: string, messages: unknown[]): void {
  let seq = maxMessageSeq(db, conversationId) + 1;
  for (const message of messages) {
    if (appendOneMessage(db, conversationId, seq, message)) seq++;
  }
}

/** Persists one message, degrading an over-cap row instead of failing the
 * turn. Returns whether a row was written (so the caller advances seq). Only
 * the event-size cap is handled here; any other store error propagates. */
function appendOneMessage(db: DatabaseSync, conversationId: string, seq: number, message: unknown): boolean {
  const role = roleOf(message);
  try {
    createMessage(db, conversationId, { id: crypto.randomUUID(), seq, role, contentJson: serializeForStore(message) });
    return true;
  } catch (error) {
    if (!(error instanceof ConversationEventTooLargeError)) throw error;
    const stripped = stripInlineImages(message);
    if (stripped !== message) {
      try {
        createMessage(db, conversationId, { id: crypto.randomUUID(), seq, role, contentJson: serializeForStore(stripped) });
        return true;
      } catch (retryError) {
        if (!(retryError instanceof ConversationEventTooLargeError)) throw retryError;
      }
    }
    console.warn(`dropping over-cap ${role} message at seq ${seq} for ${conversationId}: ${error.message}`);
    return false;
  }
}

/** Persists one run's agent_end.messages. Those are per-run (pi-agent-core
 * builds them per agentLoop invocation), so consecutive runs - including
 * auto-retry continuations, which restart with an empty array - never overlap.
 * User messages are stored too (pi injects its own, e.g. continuation nudges);
 * only the rows the prompt path persisted eagerly are skipped, each
 * eagerUserContent entry consuming its first match. Identity is the serialized
 * content array, not the whole message: pi re-stamps the prompt's timestamp
 * when it builds the run's user message. */
export function persistTurnTranscript(
  db: DatabaseSync,
  conversationId: string,
  messages: unknown[],
  eagerUserContent: string[] = [],
): void {
  const unconsumed = [...eagerUserContent];
  appendStoredMessages(db, conversationId, messages.filter((message) => {
    if (roleOf(message) !== "user") return true;
    const index = unconsumed.indexOf(JSON.stringify((message as { content?: unknown }).content));
    if (index === -1) return true;
    unconsumed.splice(index, 1);
    return false;
  }));
}

/** Builds the SessionManager a rebuilt pi session starts from by replaying
 * the stored transcript into a fresh manager from the factory: a manager that
 * already holds entries makes createAgentSession restore agent.state.messages
 * from buildSessionContext(), the same native resume path pi uses for its own
 * JSONL session files. Roles route the way pi's live persistence routes them:
 * custom messages become custom_message entries (so extensions can rescan
 * them), user/assistant/toolResult a message entry each; pi-internal roles
 * that never reach the store are skipped. Truncated toolResult stubs seed
 * as-is - the stub is still a well-formed toolResult paired to its toolCall
 * and its text head carries the gist. Compaction summaries are absent from
 * the store (they never appear in agent_end.messages); an overlong seed is
 * left to pi's own compaction. Failure is all-or-nothing: any row that fails
 * to parse or validate discards the possibly part-seeded manager for a fresh
 * unseeded one, with one warning - a partial seed could strand a toolCall
 * without its toolResult, which providers reject on the next request. */
export function seedSessionFromStore(
  db: DatabaseSync,
  conversationId: string,
  createSessionManager: () => SessionManager,
): SessionManager {
  const seeded = createSessionManager();
  try {
    for (const row of listMessages(db, conversationId)) {
      const message = JSON.parse(row.contentJson) as unknown;
      // Reject shapes that would append fine but blow up buildSessionContext
      // later, inside createAgentSession, where the throw would brick the
      // session instead of degrading it.
      if (typeof message !== "object" || message === null) {
        throw new Error(`row ${row.seq} is not a message object`);
      }
      const role = roleOf(message);
      if (role === "custom") {
        const custom = message as { customType?: unknown; content?: unknown; display?: unknown; details?: unknown };
        if (
          typeof custom.customType !== "string" ||
          typeof custom.display !== "boolean" ||
          !(typeof custom.content === "string" || Array.isArray(custom.content))
        ) {
          throw new Error(`row ${row.seq} is not a well-formed custom message`);
        }
        seeded.appendCustomMessageEntry(
          custom.customType,
          custom.content as Parameters<SessionManager["appendCustomMessageEntry"]>[1],
          custom.display,
          custom.details,
        );
      } else if (role === "user" || role === "assistant" || role === "toolResult") {
        seeded.appendMessage(message as Parameters<SessionManager["appendMessage"]>[0]);
      }
    }
    return seeded;
  } catch (error) {
    console.warn(
      `failed to replay stored history for ${conversationId}; starting the session unseeded:`,
      error instanceof Error ? error.message : error,
    );
    return createSessionManager();
  }
}
