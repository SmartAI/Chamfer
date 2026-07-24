import type { AssistantMessage, AssistantMessageEvent, Usage } from "@earendil-works/pi-ai";
import type { LlmStreamer } from "./llm";
import { TITLE_SYSTEM_PROMPT } from "./titles";
import { sanitizeModelRequest, type ModelRequestDiagnostic } from "./imageContextDiagnostics";

/**
 * Minimal deterministic fake LLM for CHAMFER_FAKE_LLM=1 runs. The scripted CAD
 * tool corpus died with the in-browser agent loop; the surviving fake answers
 * plain text (titles included), which is all the remaining hermetic surface
 * (settings, models, conversation CRUD, title generation) needs.
 */

export interface FakeLlmTestController extends LlmStreamer {
  getRequestDiagnostics(conversationId: string): ModelRequestDiagnostic[];
  isRequestHeld(conversationId: string): boolean;
  releaseHeldRequest(conversationId: string): boolean;
}

export const FAKE_MODEL = {
  id: "chamfer-fake",
  name: "Chamfer Fake Model",
  api: "anthropic-messages",
  provider: "anthropic" as const,
  baseUrl: "http://127.0.0.1/fake",
  reasoning: false,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 4096,
  maxInputImages: 3,
};

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function message(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: FAKE_MODEL.api,
    provider: FAKE_MODEL.provider,
    model: FAKE_MODEL.id,
    usage: ZERO_USAGE,
    stopReason,
    timestamp: Date.now(),
  };
}

function* streamText(text: string): Generator<AssistantMessageEvent> {
  const partial = message([{ type: "text", text }], "stop");
  yield { type: "start", partial };
  yield { type: "text_start", contentIndex: 0, partial };
  yield { type: "text_delta", contentIndex: 0, delta: text, partial };
  yield { type: "text_end", contentIndex: 0, content: text, partial };
  yield { type: "done", reason: "stop", message: partial };
}

export function fakeLlm(): FakeLlmTestController {
  const diagnostics = new Map<string, ModelRequestDiagnostic[]>();
  return {
    getRequestDiagnostics(conversationId) {
      return [...(diagnostics.get(conversationId) ?? [])];
    },
    isRequestHeld() {
      return false;
    },
    releaseHeldRequest() {
      return false;
    },
    async *stream(_model, context, options): AsyncIterable<AssistantMessageEvent> {
      const { systemPrompt } = context as { systemPrompt?: string };
      // Title-generation calls (see titles.ts) are matched exactly: a substring
      // probe would also hit unrelated system prompts.
      if (systemPrompt === TITLE_SYSTEM_PROMPT) {
        yield* streamText("Fake Box Design");
        return;
      }
      const conversationId = typeof options.sessionId === "string" ? options.sessionId : "unscoped";
      const captures = diagnostics.get(conversationId) ?? [];
      captures.push(sanitizeModelRequest(captures.length + 1, context));
      diagnostics.set(conversationId, captures);
      yield* streamText("Fake response.");
    },
  };
}
