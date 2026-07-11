export interface TurnStats {
  /** Total assistant messages in the conversation — each is one LLM call,
   * including the live streaming partial. */
  llmCalls: number;
  /** run_build123d tool calls issued since the most recent user message,
   * i.e. within the current agent turn. */
  cadRunsThisTurn: number;
}

interface LooseMessage {
  role?: unknown;
  content?: unknown;
}

function countCadCalls(message: LooseMessage): number {
  if (!Array.isArray(message.content)) return 0;
  return message.content.filter(
    (block: { type?: unknown; name?: unknown }) =>
      block?.type === "toolCall" && block?.name === "run_build123d",
  ).length;
}

/** Live conversation counters for the composer status strip. Tolerates arbitrary
 * message shapes (replayed history, malformed content) by simply not counting them. */
export function turnStats(messages: unknown[]): TurnStats {
  let llmCalls = 0;
  let cadRunsThisTurn = 0;
  for (const raw of messages) {
    const message = (typeof raw === "object" && raw !== null ? raw : {}) as LooseMessage;
    if (message.role === "user") {
      cadRunsThisTurn = 0;
      continue;
    }
    if (message.role === "assistant") {
      llmCalls += 1;
      cadRunsThisTurn += countCadCalls(message);
    }
  }
  return { llmCalls, cadRunsThisTurn };
}
