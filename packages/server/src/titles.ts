import type { MessageDto } from "@chamfer/shared";
import type { LlmStreamer } from "./llm";

export const TITLE_SYSTEM_PROMPT =
  "You name conversations from a CAD modeling assistant. " +
  "Reply with only a short descriptive title for the conversation, 3 to 6 words, " +
  "no quotes, no trailing punctuation, no explanations.";

const MAX_TRANSCRIPT_MESSAGES = 4;
const MAX_MESSAGE_CHARS = 500;
export const MAX_TITLE_CHARS = 60;

/** Text blocks of a persisted pi AgentMessage; user content may also be a plain string. */
function messageText(parsed: unknown): { role: "user" | "assistant"; text: string } | undefined {
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const { role, content } = parsed as { role?: unknown; content?: unknown };
  if (role !== "user" && role !== "assistant") return undefined;
  let text = "";
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    text = content
      .filter((block): block is { type: "text"; text: string } => {
        const b = block as { type?: unknown; text?: unknown };
        return b?.type === "text" && typeof b.text === "string";
      })
      .map((block) => block.text)
      .join("\n");
  }
  text = text.trim();
  if (!text) return undefined;
  return { role, text: text.slice(0, MAX_MESSAGE_CHARS) };
}

/**
 * Builds the summarization input from a conversation's opening messages.
 * Returns "" when there is nothing textual to summarize (e.g. image-only
 * openers), which callers treat as "skip generation".
 */
export function buildTitleTranscript(messages: MessageDto[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    if (lines.length >= MAX_TRANSCRIPT_MESSAGES) break;
    let parsed: unknown;
    try {
      parsed = JSON.parse(message.contentJson);
    } catch {
      continue;
    }
    const extracted = messageText(parsed);
    if (!extracted) continue;
    lines.push(`${extracted.role === "user" ? "User" : "Assistant"}: ${extracted.text}`);
  }
  return lines.join("\n\n");
}

/** Normalizes raw LLM output into a sidebar-safe title; "" means unusable. */
export function sanitizeTitle(raw: string): string {
  let title = raw.split("\n").map((line) => line.trim()).find((line) => line.length > 0) ?? "";
  title = title.replace(/^["'`“‘]+|["'`”’]+$/g, "");
  title = title.replace(/\s+/g, " ").replace(/[.:!,;]+$/, "").trim();
  if (title.length > MAX_TITLE_CHARS) title = `${title.slice(0, MAX_TITLE_CHARS).trimEnd()}…`;
  return title;
}

/**
 * Runs one non-tool LLM call over the transcript and returns the sanitized
 * title ("" when the model produced no usable text). Provider/transport
 * failures propagate as thrown errors.
 */
export async function generateTitleText(
  llm: LlmStreamer,
  model: unknown,
  transcript: string,
  options: Record<string, unknown>,
): Promise<string> {
  const context = {
    systemPrompt: TITLE_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: `Name this conversation:\n\n${transcript}` }],
        timestamp: Date.now(),
      },
    ],
  };
  let text = "";
  for await (const event of llm.stream(model, context, options)) {
    if (event.type === "text_delta") text += event.delta;
    if (event.type === "error") throw new Error(event.error.errorMessage ?? "title generation failed");
    if (event.type === "done" && !text) {
      text = event.message.content
        .filter((block) => block.type === "text")
        .map((block) => (block as { text: string }).text)
        .join("\n");
    }
  }
  return sanitizeTitle(text);
}
