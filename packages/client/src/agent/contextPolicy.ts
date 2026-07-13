import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { findSkill, skillBodyText, skillResourceText } from "./skillRegistry";
import { isSkillLoadResult, skillLoadKey, type LoadSkillDetails } from "./tools/loadSkill";
import {
  currentInspectionSheet,
  INSPECTION_SHEET_STUB_TEXT,
  isInspectionSheetResult,
  projectCurrentInspectionSheet,
} from "./inspectionSheetLifecycle";

/**
 * Chamfer's LLM-visible context policy: what the model sees may be smaller than the
 * persisted transcript, but the transcript itself is never rewritten. Three mechanisms:
 *
 * 1. Current-sheet projection: exactly the newest successful run_build123d sheet stays
 *    pixel-bearing during reasoning and repair. Older and finalized sheets become compact
 *    evidence in model context only; the DB row and UI retain their attachment references.
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

export const SHEET_STUB_TEXT = INSPECTION_SHEET_STUB_TEXT;

const FAILED_TOOL_NON_TEXT_STUB = "[Non-text tool result content omitted because the tool failed.]";
const EMPTY_FAILED_TOOL_STUB = "Tool failed without a text error message.";

interface ContentBlock {
  type?: string;
  text?: string;
}

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

/** True for a run_build123d tool result still carrying its inspection-sheet image. */
export function isSheetResult(message: unknown): boolean {
  return isInspectionSheetResult(message);
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

function textOnlyFailedToolResults(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((message) => {
    const result = message as unknown as { role?: unknown; isError?: unknown; content?: unknown };
    if (result.role !== "toolResult" || result.isError !== true) return message;

    const content = Array.isArray(result.content) ? result.content : [];
    const textContent = content.map((block: ContentBlock) =>
      block?.type === "text" ? block : { type: "text", text: FAILED_TOOL_NON_TEXT_STUB },
    );
    return {
      ...(message as object),
      content: textContent.length > 0 ? textContent : [{ type: "text", text: EMPTY_FAILED_TOOL_STUB }],
    } as AgentMessage;
  });
}

/** Compatibility name retained for callers while the policy is now one current sheet. */
export function applySheetStubs(messages: AgentMessage[]): AgentMessage[] {
  return projectCurrentInspectionSheet(messages);
}

/**
 * Full LLM-visible context for a transcript: compaction boundary first, then sheet
 * stubbing over what remains. Contract (pi transformContext): must never throw; any
 * unexpected shape falls back to the untransformed transcript.
 */
export function transformLlmContext(messages: AgentMessage[]): AgentMessage[] {
  try {
    const boundary = compactionBoundary(messages);
    const currentSheet = currentInspectionSheet(messages);
    let context: AgentMessage[];
    if (boundary) {
      const tail = [
        ...messages.slice(boundary.visibleStart, boundary.index),
        ...messages.slice(boundary.index + 1),
      ].filter((message) => !isCompactionMessage(message));
      const skillContext = skillReinjectionMessage(messages, boundary.visibleStart, boundary.row.timestamp);
      const pinnedSheet = currentSheet && !tail.includes(currentSheet) ? [currentSheet] : [];
      context = [
        summaryAsUserMessage(boundary.row),
        ...pinnedSheet,
        ...(skillContext ? [skillContext] : []),
        ...tail,
      ];
    } else {
      context = messages.filter((message) => !isCompactionMessage(message));
    }
    return projectCurrentInspectionSheet(textOnlyFailedToolResults(context));
  } catch {
    return messages;
  }
}
