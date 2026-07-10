import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";

export type PiEvent = AssistantMessageEvent;

/** Server-side abstraction over pi-ai's streaming call, injectable for tests. */
export interface LlmStreamer {
  stream(model: unknown, context: unknown, options: Record<string, unknown>): AsyncIterable<PiEvent>;
}

/** Real LLM streamer backed by pi-ai's built-in provider registry. */
export function realLlm(): LlmStreamer {
  return {
    stream(model, context, options) {
      const models = builtinModels();
      // The wire body from the browser is untyped JSON; cast at this single boundary.
      return models.stream(model as never, context as never, options as never);
    },
  };
}
