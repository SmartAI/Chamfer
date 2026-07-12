import {
  DEFAULT_COMPACTION_SETTINGS,
  estimateContextTokens,
  estimateTokens,
  serializeConversation,
  shouldCompact,
} from "@earendil-works/pi-agent-core";
import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, Message, Model } from "@earendil-works/pi-ai";
import { compactionBoundary, transformLlmContext, type CompactionMessage } from "./contextPolicy";
import { isPlanToolResult } from "./plan";

/**
 * Domain-aware context compaction for long design sessions, built on pi's compaction
 * primitives (token estimation, threshold, summarization prompt) but with a Chamfer
 * summary contract and Chamfer's non-destructive persistence model: the summary is a
 * new `compaction` row appended to the transcript; contextPolicy.ts derives the
 * LLM-visible window from it and the stored history is never rewritten.
 */

export const COMPACTION_SETTINGS = DEFAULT_COMPACTION_SETTINGS;

// pi-agent-core declares SUMMARIZATION_SYSTEM_PROMPT but does not re-export it from
// the package index, so the equivalent contract is restated here.
const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

/** Fallback when the configured model does not declare a context window. */
const DEFAULT_CONTEXT_WINDOW = 200_000;

/** Below this many messages to summarize, compaction is not worth an LLM call. */
const MIN_MESSAGES_TO_SUMMARIZE = 4;

export const CHAMFER_SUMMARY_INSTRUCTIONS = `This conversation is a CAD design session: a user directing an agent that writes build123d scripts, runs them, and verifies the geometry against a verify gate.

The summary MUST preserve, verbatim where stated:
1. Every user-stated requirement: dimensions, tolerances, counts, spacings, angles, materials, orientations, units, and named features. Never round, drop, or paraphrase a number.
2. The overall design intent and its component breakdown, with per-component status: built and gate-passed, built but failing, or not started.
3. Decisions and corrections made along the way, including anything the user explicitly rejected or changed their mind about.
4. The most recent verify-gate verdict and measured overall dimensions, and what remains to be done next.

Format as short titled sections with bullet lists. Do not include Python code; the latest script is stored separately and remains available to the agent. Do not restate the content of loaded skills (load_skill results); they are re-attached to the context mechanically.`;

/** True when a toolResult message carries a verify-gate verdict. */
function hasGateVerdict(message: unknown): boolean {
  if (typeof message !== "object" || message === null) return false;
  const m = message as { role?: unknown; details?: { gate?: { status?: unknown } } };
  return m.role === "toolResult" && typeof m.details?.gate?.status === "string";
}

function isUserMessage(message: unknown): boolean {
  return typeof message === "object" && message !== null && (message as { role?: unknown }).role === "user";
}

/** Estimated tokens of the current LLM-visible context, and whether that crosses pi's compaction threshold. */
export function needsCompaction(messages: AgentMessage[], model: Model<Api>): { tokens: number } | undefined {
  const contextWindow =
    typeof model.contextWindow === "number" && model.contextWindow > 0
      ? model.contextWindow
      : DEFAULT_CONTEXT_WINDOW;
  const estimate = estimateContextTokens(transformLlmContext(messages));
  return shouldCompact(estimate.tokens, contextWindow, COMPACTION_SETTINGS) ? { tokens: estimate.tokens } : undefined;
}

/**
 * First transcript index of the kept tail: walking back from the end until roughly
 * `keepRecentTokens` are retained, snapped back to the start of a user turn so
 * assistant/toolResult pairs are never split, never past the newest verify-gate
 * result (the latest gate + measurements always stay verbatim), and never past the
 * newest accepted plan snapshot (the plan of record must stay in context verbatim).
 * Returns a value <= `floor` when there is nothing worth summarizing.
 */
export function findCompactionCut(
  messages: readonly unknown[],
  floor: number,
  keepRecentTokens: number = COMPACTION_SETTINGS.keepRecentTokens,
): number {
  let accumulated = 0;
  let candidate = messages.length;
  for (let index = messages.length - 1; index >= floor; index -= 1) {
    accumulated += estimateTokens(messages[index] as AgentMessage);
    candidate = index;
    if (accumulated >= keepRecentTokens) break;
  }

  for (const keep of [hasGateVerdict, isPlanToolResult]) {
    for (let index = messages.length - 1; index >= floor; index -= 1) {
      if (keep(messages[index])) {
        if (index < candidate) candidate = index;
        break;
      }
    }
  }

  for (let index = Math.min(candidate, messages.length - 1); index >= floor; index -= 1) {
    if (isUserMessage(messages[index])) return index;
  }
  return floor;
}

/** Every image block replaced with a text placeholder so the summary request stays small. */
function withoutImages(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((message) => {
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content) || !content.some((block: { type?: string }) => block?.type === "image")) {
      return message;
    }
    return {
      ...(message as object),
      content: content.map((block: { type?: string }) =>
        block?.type === "image" ? { type: "text", text: "[image omitted]" } : block,
      ),
    } as AgentMessage;
  });
}

export interface RunCompactionArgs {
  messages: AgentMessage[];
  model: Model<Api>;
  streamFn: StreamFn;
  /** Called right before the summary LLM call starts (feeds the "compacting" UI status). */
  onStart?: () => void;
}

/**
 * Decides whether compaction should run and, if so, generates the domain-aware
 * summary and returns the compaction row to append and persist. Returns undefined
 * when compaction is unnecessary or not worthwhile. Throws when the summary LLM
 * call itself fails; callers treat that as non-fatal and skip compaction.
 */
export async function runCompaction({ messages, model, streamFn, onStart }: RunCompactionArgs): Promise<CompactionMessage | undefined> {
  const needed = needsCompaction(messages, model);
  if (!needed) return undefined;

  const boundary = compactionBoundary(messages);
  const floor = boundary ? boundary.index + 1 : 0;
  const cut = findCompactionCut(messages, floor);
  // Also summarize the previous boundary's kept tail (visibleStart..boundary.index):
  // it precedes the new cut, so it leaves the context and must fold into the summary.
  const visibleStart = boundary ? boundary.visibleStart : 0;
  const toSummarize = messages
    .slice(visibleStart, cut)
    .filter((message) => (message as { role?: unknown }).role !== "compaction");
  if (toSummarize.length < MIN_MESSAGES_TO_SUMMARIZE) return undefined;

  onStart?.();
  const conversation = serializeConversation(withoutImages(toSummarize) as Message[]);
  const parts = [
    boundary ? `Previous summary of even earlier work:\n${boundary.row.summary}` : undefined,
    `Conversation to summarize:\n${conversation}`,
    CHAMFER_SUMMARY_INSTRUCTIONS,
  ].filter(Boolean);
  const request = {
    systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
    messages: [
      { role: "user", content: [{ type: "text", text: parts.join("\n\n") }], timestamp: Date.now() },
    ] as Message[],
    tools: [],
  };

  const stream = await streamFn(model, request, {});
  const result = await stream.result();
  if (result.stopReason === "error" || result.stopReason === "aborted") {
    throw new Error(result.errorMessage ?? "compaction summary generation failed");
  }
  const summary = result.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
  if (!summary) throw new Error("compaction summary generation returned no text");

  return {
    role: "compaction",
    summary,
    keptTail: messages.length - cut,
    tokensBefore: needed.tokens,
    timestamp: Date.now(),
  };
}
