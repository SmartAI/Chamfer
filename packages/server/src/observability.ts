import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { propagateAttributes, startObservation } from "@langfuse/tracing";
import type { Usage } from "@earendil-works/pi-ai";
import type { LlmStreamer } from "./llm";

type Env = Record<string, string | undefined>;

export interface LangfuseConfig {
  publicKey: string;
  secretKey: string;
  baseUrl: string;
}

/**
 * Reads Langfuse credentials from the environment. Tracing is enabled only
 * when both LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are set; undefined
 * means the server runs without any observability.
 */
export function langfuseConfig(env: Env = process.env): LangfuseConfig | undefined {
  const publicKey = env.LANGFUSE_PUBLIC_KEY;
  const secretKey = env.LANGFUSE_SECRET_KEY;
  if (!publicKey || !secretKey) return undefined;
  return { publicKey, secretKey, baseUrl: env.LANGFUSE_BASE_URL || "https://cloud.langfuse.com" };
}

/**
 * When Langfuse is configured, registers a global OTel tracer provider that
 * exports to Langfuse; the observeLlm wrappers installed by createApp then
 * record every LLM call as a generation. Does nothing when unconfigured, in
 * which case those wrappers stay no-ops.
 */
export function initObservability(env: Env = process.env): void {
  const config = langfuseConfig(env);
  if (!config) return;
  const provider = new NodeTracerProvider({ spanProcessors: [new LangfuseSpanProcessor(config)] });
  provider.register();
  flushOnShutdown(provider);
  console.log(`chamfer: langfuse tracing enabled (${config.baseUrl})`);
}

/**
 * Spans export in batches, so the last few LLM calls would be lost when the
 * user Ctrl-C's the server. Flush before exiting, bounded so an unreachable
 * Langfuse host can never keep the process alive.
 */
function flushOnShutdown(provider: NodeTracerProvider): void {
  const flushThenExit = (code: number) => () => {
    const deadline = new Promise<void>((resolve) => setTimeout(resolve, 2000).unref());
    Promise.race([provider.shutdown().catch(() => {}), deadline]).finally(() => process.exit(code));
  };
  process.once("SIGINT", flushThenExit(130));
  process.once("SIGTERM", flushThenExit(143));
}

/**
 * Wraps an LlmStreamer so each stream() call becomes a Langfuse generation
 * named after its call site (e.g. "chat-response", "conversation-title"),
 * carrying the request context, the completed output, token usage, and cost.
 * Events pass through unchanged. `options` is deliberately never recorded:
 * it carries API keys (apiKey/env). A no-op when no tracer provider is
 * registered, so it is safe to install unconditionally.
 */
export function observeLlm(llm: LlmStreamer, name: string): LlmStreamer {
  return {
    async *stream(model, context, options) {
      const provider = stringField(model, "provider");
      const sessionId = langfuseSessionId(options.sessionId);
      const createGeneration = () =>
        startObservation(
          name,
          {
            model: stringField(model, "id"),
            input: context,
            ...(provider ? { metadata: { provider } } : {}),
          },
          { asType: "generation" },
        );
      const generation = sessionId
        ? propagateAttributes({ sessionId }, createGeneration)
        : createGeneration();
      try {
        for await (const event of llm.stream(model, context, options)) {
          if (event.type === "done") {
            generation.update({
              output: event.message.content,
              ...usageAttributes(event.message.usage),
            });
          } else if (event.type === "error") {
            generation.update({
              level: event.error.stopReason === "aborted" ? "WARNING" : "ERROR",
              statusMessage: event.error.errorMessage ?? event.error.stopReason,
              ...usageAttributes(event.error.usage),
            });
          }
          yield event;
        }
      } catch (e) {
        generation.update({ level: "ERROR", statusMessage: e instanceof Error ? e.message : String(e) });
        throw e;
      } finally {
        generation.end();
      }
    },
  };
}

/** Langfuse accepts US-ASCII session IDs shorter than 200 characters. */
export function langfuseSessionId(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length >= 200) return undefined;
  return /^[\x20-\x7E]+$/.test(value) ? value : undefined;
}

function stringField(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : undefined;
}

/**
 * Maps pi-ai usage onto Langfuse usageDetails/costDetails. Tolerates a
 * missing usage (returns no attributes): tracing must never be the reason a
 * stream fails.
 */
export function usageAttributes(usage: Usage | undefined): {
  usageDetails?: Record<string, number>;
  costDetails?: Record<string, number>;
} {
  if (!usage) return {};
  const usageDetails: Record<string, number> = {
    input: usage.input,
    output: usage.output,
    cache_read_input_tokens: usage.cacheRead,
    cache_creation_input_tokens: usage.cacheWrite,
    total: usage.totalTokens,
  };
  if (usage.reasoning !== undefined) usageDetails.reasoning = usage.reasoning;
  if (!usage.cost) return { usageDetails };
  return {
    usageDetails,
    costDetails: {
      input: usage.cost.input,
      output: usage.cost.output,
      cache_read_input_tokens: usage.cost.cacheRead,
      cache_creation_input_tokens: usage.cost.cacheWrite,
      total: usage.cost.total,
    },
  };
}
