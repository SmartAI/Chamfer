import type { ProxyAssistantMessageEvent } from "@earendil-works/pi-agent-core";
import type { PiEvent } from "./llm";

/**
 * Maps a pi-ai AssistantMessageEvent (server-side, carries the heavy
 * `partial` AssistantMessage on most events) to the wire-level
 * ProxyAssistantMessageEvent that pi-agent-core's `streamProxy` parses.
 *
 * Rules:
 * - delta/start/end events: strip `partial` (and any other pi-ai-only
 *   fields like `content`/`toolCall`) so only the fields the proxy type
 *   declares are sent.
 * - `done`: the completed message lives on `event.message`; forward its
 *   `stopReason` as `reason` and its `usage`.
 * - `error`: the completed message lives on `event.error`; forward its
 *   `stopReason` as `reason`, its `errorMessage`, and its `usage`.
 */
export function toProxyEvent(event: PiEvent): ProxyAssistantMessageEvent | null {
  switch (event.type) {
    case "start":
      return { type: "start" };
    case "text_start":
      return { type: "text_start", contentIndex: event.contentIndex };
    case "text_delta":
      return { type: "text_delta", contentIndex: event.contentIndex, delta: event.delta };
    case "text_end": {
      const content = event.partial.content[event.contentIndex];
      return {
        type: "text_end",
        contentIndex: event.contentIndex,
        contentSignature: content?.type === "text" ? content.textSignature : undefined,
      };
    }
    case "thinking_start":
      return { type: "thinking_start", contentIndex: event.contentIndex };
    case "thinking_delta":
      return { type: "thinking_delta", contentIndex: event.contentIndex, delta: event.delta };
    case "thinking_end": {
      const content = event.partial.content[event.contentIndex];
      return {
        type: "thinking_end",
        contentIndex: event.contentIndex,
        contentSignature: content?.type === "thinking" ? content.thinkingSignature : undefined,
      };
    }
    case "toolcall_start": {
      // pi-ai's toolcall_start only carries contentIndex + partial (the
      // in-progress AssistantMessage); the proxy wire format wants the
      // tool call's id/name up front, so pull it from the partial content.
      const content = event.partial.content[event.contentIndex];
      const toolCall = content?.type === "toolCall" ? content : undefined;
      return {
        type: "toolcall_start",
        contentIndex: event.contentIndex,
        id: toolCall?.id ?? "",
        toolName: toolCall?.name ?? "",
      };
    }
    case "toolcall_delta":
      return { type: "toolcall_delta", contentIndex: event.contentIndex, delta: event.delta };
    case "toolcall_end":
      return { type: "toolcall_end", contentIndex: event.contentIndex, toolCall: event.toolCall };
    case "done":
      return { type: "done", reason: event.message.stopReason as "stop" | "length" | "toolUse", usage: event.message.usage };
    case "error":
      return {
        type: "error",
        reason: event.error.stopReason as "aborted" | "error",
        errorMessage: event.error.errorMessage,
        usage: event.error.usage,
      };
    default:
      return null;
  }
}
