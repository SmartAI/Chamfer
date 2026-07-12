import { DEFAULT_SKILL_MODE, type Build123dSkillMode } from "./build123dSkill";

export interface AblationScore {
  gatePassed: boolean;
  cadRuns: number;
  searches: number;
  skillLoads: number;
  inputTokens: number;
  outputTokens: number;
  failureCategories: Record<string, number>;
  repeatedFailureCategories: string[];
}

type UnknownRecord = Record<string, unknown>;

export function resolveAblationSkill(search: string, isDevelopment: boolean): Build123dSkillMode {
  if (!isDevelopment) return DEFAULT_SKILL_MODE;
  const value = new URLSearchParams(search).get("chamferSkill");
  return value === "none" || value === "core" || value === "full" ? value : DEFAULT_SKILL_MODE;
}

function record(value: unknown): UnknownRecord | undefined {
  return typeof value === "object" && value !== null ? value as UnknownRecord : undefined;
}

function textContent(message: UnknownRecord): string {
  const content = Array.isArray(message.content) ? message.content : [];
  return content
    .map((item) => record(item))
    .filter((item): item is UnknownRecord => Boolean(item))
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text as string)
    .join("\n");
}

function toolCalls(message: UnknownRecord): UnknownRecord[] {
  if (!Array.isArray(message.content)) return [];
  return message.content
    .map((item) => record(item))
    .filter((item): item is UnknownRecord => item?.type === "toolCall");
}

function gateFailureCategories(text: string): string[] {
  if (!text.includes("Verify gate: FAILED")) return [];
  return text.split("\n")
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).split(":", 1)[0]?.trim())
    .filter((category): category is string => Boolean(category));
}

export function scoreAblationMessages(messages: unknown[]): AblationScore {
  let cadRuns = 0;
  let searches = 0;
  let skillLoads = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let gatePassed = false;
  const failureCategories: Record<string, number> = {};

  for (const value of messages) {
    const message = record(value);
    if (!message) continue;

    const usage = record(message.usage);
    inputTokens += typeof usage?.input === "number" ? usage.input : 0;
    outputTokens += typeof usage?.output === "number" ? usage.output : 0;

    for (const call of toolCalls(message)) {
      if (call.name === "run_build123d") cadRuns += 1;
      if (call.name === "search_docs") searches += 1;
      if (call.name === "load_skill") skillLoads += 1;
    }

    if (message.role !== "toolResult" || message.toolName !== "run_build123d") continue;
    const text = textContent(message);
    if (text.includes("Verify gate: PASSED")) gatePassed = true;
    for (const category of gateFailureCategories(text)) {
      failureCategories[category] = (failureCategories[category] ?? 0) + 1;
    }
  }

  return {
    gatePassed,
    cadRuns,
    searches,
    skillLoads,
    inputTokens,
    outputTokens,
    failureCategories,
    repeatedFailureCategories: Object.entries(failureCategories)
      .filter(([, count]) => count > 1)
      .map(([category]) => category)
      .sort(),
  };
}
