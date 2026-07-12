import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { findSkill, skillBodyText, skillResourceText } from "./skillRegistry";
import { isSkillLoadResult, skillLoadKey, type LoadSkillDetails } from "./tools/loadSkill";

/**
 * Chamfer's LLM-visible context policy: what the model sees may be smaller than the
 * persisted transcript, but the transcript itself is never rewritten. Three mechanisms:
 *
 * 1. Sheet stubbing: every run_build123d result carries a ~350KB seven-view PNG. Once
 *    enough of them accumulate, older sheets are replaced by a text stub in the LLM
 *    context only (the DB row and the UI keep the image).
 * 2. Compaction boundary: a persisted `compaction` row summarizes everything before it;
 *    the LLM context becomes [summary-as-user-message, kept tail, everything after].
 * 3. Skill pinning: load_skill results are durable for the whole conversation. Loads
 *    that fall behind the compaction boundary are re-injected right after the summary
 *    (content re-read from the bundled registry, so the bytes are stable), which keeps
 *    the cut free to move past them instead of blocking compaction.
 *
 * Everything here is pure and deterministic over the message array, so the same
 * history always produces the same LLM context (prompt-cache stability across
 * reloads) and decisions about a prefix never change as new messages append.
 */

/** Stub a sheet only when more than this many un-stubbed sheets are in context. */
export const MAX_LIVE_SHEETS = 8;
/** When the threshold trips, stub down to this many newest sheets in one batch. */
export const KEEP_SHEETS = 3;

export const SHEET_STUB_TEXT =
  "[Inspection sheet image removed: superseded by newer CAD runs. The measurements and gate verdict in this result are still valid; run run_build123d again if fresh views are needed.]";

/**
 * Persisted marker row for a compaction event. Appended to the end of the transcript
 * at the moment compaction runs (seq order stays monotonic); `keptTail` counts the
 * messages immediately preceding the row that remain in the LLM context verbatim.
 */
export interface CompactionMessage {
  role: "compaction";
  /** Domain-aware summary standing in for all messages before the kept tail. */
  summary: string;
  /** Number of messages immediately before this row kept in the LLM context. */
  keptTail: number;
  /** Estimated LLM context tokens at the time compaction ran. */
  tokensBefore: number;
  timestamp: number;
}

export function isCompactionMessage(message: unknown): message is CompactionMessage {
  if (typeof message !== "object" || message === null) return false;
  const m = message as { role?: unknown; summary?: unknown; keptTail?: unknown };
  return m.role === "compaction" && typeof m.summary === "string" && typeof m.keptTail === "number";
}

interface ContentBlock {
  type?: string;
  text?: string;
}

/** True for a run_build123d tool result still carrying its inspection-sheet image. */
export function isSheetResult(message: unknown): boolean {
  if (typeof message !== "object" || message === null) return false;
  const m = message as { role?: unknown; toolName?: unknown; content?: unknown };
  if (m.role !== "toolResult" || m.toolName !== "run_build123d") return false;
  return Array.isArray(m.content) && m.content.some((block: ContentBlock) => block?.type === "image");
}

export interface CompactionBoundary {
  row: CompactionMessage;
  /** Index of the compaction row in the transcript. */
  index: number;
  /** Index of the first transcript message visible to the LLM (start of the kept tail). */
  visibleStart: number;
}

/** Newest compaction row and the visibility window it defines, or undefined. */
export function compactionBoundary(messages: readonly unknown[]): CompactionBoundary | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const row = messages[index];
    if (!isCompactionMessage(row)) continue;
    const keptTail = Number.isInteger(row.keptTail) && row.keptTail >= 0 ? row.keptTail : 0;
    return { row, index, visibleStart: Math.max(0, index - keptTail) };
  }
  return undefined;
}

/** The compaction summary presented to the model as an ordinary user message. */
export function summaryAsUserMessage(row: CompactionMessage): AgentMessage {
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: `Summary of earlier work in this conversation (the original messages were compacted away):\n\n${row.summary}`,
      },
    ],
    // The row's own timestamp, not "now": the produced context must be byte-stable
    // across calls or the prompt-cache prefix breaks on every request.
    timestamp: row.timestamp,
  } as AgentMessage;
}

/**
 * One user message restating every skill payload loaded before `visibleStart`,
 * or undefined when none. Content comes from the current registry (constant
 * within a session, so the produced context stays byte-stable for the prompt
 * cache); payloads whose skill or resource no longer exists are skipped - the
 * catalog still offers the current version for an explicit reload.
 */
export function skillReinjectionMessage(
  messages: readonly unknown[],
  visibleStart: number,
  timestamp: number,
): AgentMessage | undefined {
  const seen = new Set<string>();
  const blocks: string[] = [];
  for (const message of messages.slice(0, visibleStart)) {
    if (!isSkillLoadResult(message)) continue;
    const details = (message as { details: LoadSkillDetails }).details;
    if (details.deduped) continue;
    const key = skillLoadKey(details);
    if (seen.has(key)) continue;
    seen.add(key);
    const skill = findSkill(details.skill);
    if (!skill) continue;
    if (details.resource) {
      const content = skill.resources.get(details.resource);
      if (content !== undefined) blocks.push(skillResourceText(skill, details.resource, content));
    } else {
      blocks.push(skillBodyText(skill));
    }
  }
  if (blocks.length === 0) return undefined;
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: `The following skills were loaded earlier in this conversation (inside the compacted section) and remain in effect:\n\n${blocks.join("\n\n")}`,
      },
    ],
    timestamp,
  } as AgentMessage;
}

function stubSheet(message: AgentMessage): AgentMessage {
  const m = message as unknown as { content: ContentBlock[] };
  return {
    ...(message as object),
    content: m.content.map((block) =>
      block?.type === "image" ? { type: "text", text: SHEET_STUB_TEXT } : block,
    ),
  } as AgentMessage;
}

/**
 * Threshold + batch sheet stubbing with hysteresis, replayed deterministically over
 * the message order: walking the transcript from the start, whenever the number of
 * live (un-stubbed) sheets exceeds `maxLive`, all but the newest `keep` are stubbed
 * in one batch. Decisions about earlier messages never change as new sheets append,
 * so the prompt-cache prefix only breaks once per batch, not on every turn.
 */
export function applySheetStubs(
  messages: AgentMessage[],
  maxLive: number = MAX_LIVE_SHEETS,
  keep: number = KEEP_SHEETS,
): AgentMessage[] {
  const stubbed = new Set<number>();
  const live: number[] = [];
  messages.forEach((message, index) => {
    if (!isSheetResult(message)) return;
    live.push(index);
    if (live.length > maxLive) {
      while (live.length > keep) stubbed.add(live.shift() as number);
    }
  });
  if (stubbed.size === 0) return messages;
  return messages.map((message, index) => (stubbed.has(index) ? stubSheet(message) : message));
}

/**
 * Full LLM-visible context for a transcript: compaction boundary first, then sheet
 * stubbing over what remains. Contract (pi transformContext): must never throw; any
 * unexpected shape falls back to the untransformed transcript.
 */
export function transformLlmContext(messages: AgentMessage[]): AgentMessage[] {
  try {
    const boundary = compactionBoundary(messages);
    let context: AgentMessage[];
    if (boundary) {
      const tail = [
        ...messages.slice(boundary.visibleStart, boundary.index),
        ...messages.slice(boundary.index + 1),
      ].filter((message) => !isCompactionMessage(message));
      const skillContext = skillReinjectionMessage(messages, boundary.visibleStart, boundary.row.timestamp);
      context = [summaryAsUserMessage(boundary.row), ...(skillContext ? [skillContext] : []), ...tail];
    } else {
      context = messages.filter((message) => !isCompactionMessage(message));
    }
    return applySheetStubs(context);
  } catch {
    return messages;
  }
}
