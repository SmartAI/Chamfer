import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { LlmStreamer } from "./llm";

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
};

const ZERO_USAGE = {
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

export function fakeLlm(): LlmStreamer {
  return {
    async *stream(_model, context): AsyncIterable<AssistantMessageEvent> {
      const { messages = [], systemPrompt } = context as {
        messages?: Array<{ role?: string }>;
        systemPrompt?: string;
      };
      // Title-generation calls (see titles.ts) expect plain text, not a tool call.
      if (typeof systemPrompt === "string" && systemPrompt.includes("title")) {
        const text = "Fake Box Design";
        const partial = message([{ type: "text", text }], "stop");
        yield { type: "start", partial };
        yield { type: "text_start", contentIndex: 0, partial };
        yield { type: "text_delta", contentIndex: 0, delta: text, partial };
        yield { type: "text_end", contentIndex: 0, content: text, partial };
        yield { type: "done", reason: "stop", message: partial };
        return;
      }
      // The self-check nudge the session injects after a gate pass arrives as a
      // trailing user message; answer it with a completed checklist instead of
      // falling through to the tool-call branch (which would start a second,
      // duplicate CAD run and hang the e2e flow).
      if (JSON.stringify(messages.at(-1)).includes("[Chamfer self-check]")) {
        const text = "Checked the request: single box, all dimensions satisfied. Nothing missing.";
        const partial = message([{ type: "text", text }], "stop");
        yield { type: "start", partial };
        yield { type: "text_start", contentIndex: 0, partial };
        yield { type: "text_delta", contentIndex: 0, delta: text, partial };
        yield { type: "text_end", contentIndex: 0, content: text, partial };
        yield { type: "done", reason: "stop", message: partial };
        return;
      }
      // The gate-fail scenario (triggered by "gate-fail" anywhere in the
      // transcript) emits a script whose EXPECT bbox is deliberately wrong,
      // so e2e can exercise a failing verify gate end to end.
      const gateFail = JSON.stringify(messages).includes("gate-fail");
      if (messages.at(-1)?.role === "toolResult") {
        const text = gateFail
          ? "The verify gate failed as expected for this scenario."
          : "Built a 10x20x30 box. All views verified.";
        const partial = message([{ type: "text", text }], "stop");
        yield { type: "start", partial };
        yield { type: "text_start", contentIndex: 0, partial };
        yield { type: "text_delta", contentIndex: 0, delta: text, partial };
        yield { type: "text_end", contentIndex: 0, content: text, partial };
        yield { type: "done", reason: "stop", message: partial };
        return;
      }

      const code = [
        "from build123d import *",
        "# --- params ---",
        "width = 10  # [1, 100] Width in mm",
        "depth = 20  # [1, 100] Depth in mm",
        "height = 30  # [1, 100] Height in mm",
        "# --- end params ---",
        "# --- expect ---",
        // The gate-fail variant expects a 31mm dimension the box never has.
        `EXPECT = {"bodies": 1, "bbox_mm": [10, 20, ${gateFail ? 31 : 30}]}`,
        "# --- end expect ---",
        "result = Box(width, depth, height)",
      ].join("\n");
      const args = JSON.stringify({ code });
      const toolCall = { type: "toolCall" as const, id: "fake-run-1", name: "run_build123d", arguments: {} };
      const partial = message([toolCall], "toolUse");
      yield { type: "start", partial };
      yield { type: "toolcall_start", contentIndex: 0, partial };
      yield { type: "toolcall_delta", contentIndex: 0, delta: args, partial };
      const complete = message([{ ...toolCall, arguments: { code } }], "toolUse");
      yield { type: "toolcall_end", contentIndex: 0, toolCall: complete.content[0] as never, partial: complete };
      yield { type: "done", reason: "toolUse", message: complete };
    },
  };
}
