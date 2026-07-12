import { loadedSkillKeys } from "./tools/loadSkill";
import { findSkill } from "./skillRegistry";

/**
 * Deterministic verify-gate nudge: when the model fails the same way twice in
 * one turn and a registered skill covers that failure pattern, one hint line is
 * appended to the failing run_build123d result. Suppressed once the skill is
 * loaded, and silent for failure categories no rule maps - a wrong pointer is
 * worse than none. This is the push half of the skill design; the catalog in
 * the system prompt is the pull half.
 */

export const SKILL_HINT_PREFIX = "Skill hint:";

/** How many matching failures in one turn trigger the hint (the Nth failure carries it). */
export const SKILL_NUDGE_THRESHOLD = 2;

interface SkillNudgeRule {
  skill: string;
  /** Tested against the full failure text: gate check details and Python tracebacks. */
  pattern: RegExp;
}

// Order matters: the first matching rule wins, so the most specific
// signatures come first. surgical-edits has no rule - "the edit regressed
// something" is not detectable from a single failure text.
export const SKILL_NUDGE_RULES: readonly SkillNudgeRule[] = [
  { skill: "recover-disjoint-solids", pattern: /bodies:\s*expected\s+1,\s*found\s+[2-9]\d*/i },
  { skill: "recover-collapsing-lofts", pattern: /(?:loft[^\n]*(?:tessell|BRep|collaps|pinch|twist)|tessell[^\n]*loft)/i },
  { skill: "recover-coincident-booleans", pattern: /coincident(?:-face)?|zero[- ]thickness/i },
  { skill: "sweep-and-loft", pattern: /\b(sweep|loft)\b/i },
  { skill: "holes-and-threads", pattern: /hole_through|hole_blind|hole_internal|CounterBore|CounterSink|\bHole\b/ },
  { skill: "selectors-and-patterns", pattern: /filter_by|sort_by|group_by|Select\.|GridLocations|PolarLocations|HexLocations|symmetric/ },
  { skill: "booleans-and-features", pattern: /bodies: expected|interpenetrat|\bfuse\b|\bintersect\b|coincident/i },
  { skill: "placement-and-frames", pattern: /\bfloating\b|clearance/i },
];

function contentText(message: unknown): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } =>
      typeof block === "object" && block !== null &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string")
    .map((block) => block.text)
    .join("\n");
}

/** Failure text of a run_build123d tool result: tracebacks and failed-gate output. */
function runFailureText(message: unknown): string | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const m = message as { role?: unknown; toolName?: unknown; isError?: unknown };
  if (m.role !== "toolResult" || m.toolName !== "run_build123d") return undefined;
  const text = contentText(message);
  if (m.isError === true) return text;
  return text.includes("Verify gate: FAILED") ? text : undefined;
}

/** Session-injected user messages (self-check, plan nudge) do not start a new turn. */
function isRealUserMessage(message: unknown): boolean {
  if (typeof message !== "object" || message === null) return false;
  if ((message as { role?: unknown }).role !== "user") return false;
  return !contentText(message).startsWith("[Chamfer ");
}

function currentTurnMessages(messages: readonly unknown[]): readonly unknown[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isRealUserMessage(messages[index])) return messages.slice(index + 1);
  }
  return messages;
}

/**
 * The hint line for a just-failed run_build123d result, or undefined.
 *
 * `messages` is the agent context at finalization time (the current result is
 * not part of it yet); `failureText` is the current result's text. A rule
 * fires when the current failure is at least the SKILL_NUDGE_THRESHOLDth
 * matching one this turn, the mapped skill exists, and it is not yet loaded.
 */
export function skillNudgeLine(messages: readonly unknown[], failureText: string): string | undefined {
  const turn = currentTurnMessages(messages);
  const loaded = loadedSkillKeys(messages);
  for (const rule of SKILL_NUDGE_RULES) {
    if (!rule.pattern.test(failureText)) continue;
    if (loaded.has(rule.skill) || !findSkill(rule.skill)) continue;
    const priorMatches = turn.filter((message) => {
      const text = runFailureText(message);
      return text !== undefined && rule.pattern.test(text);
    }).length;
    if (priorMatches + 1 >= SKILL_NUDGE_THRESHOLD) {
      return `${SKILL_HINT_PREFIX} load_skill("${rule.skill}") covers this failure pattern.`;
    }
  }
  return undefined;
}

/** afterToolCall glue: the extra content block for a finalized run_build123d result, or undefined. */
export function skillNudgeBlock(
  messages: readonly unknown[],
  result: { content?: unknown },
  isError: boolean,
): { type: "text"; text: string } | undefined {
  const text = contentText(result);
  if (!isError && !text.includes("Verify gate: FAILED")) return undefined;
  const line = skillNudgeLine(messages, text);
  return line ? { type: "text", text: line } : undefined;
}
