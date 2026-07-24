import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { propagateAttributes, startObservation } from "@langfuse/tracing";
import type { Usage } from "@earendil-works/pi-ai";
import type { AgentRunLifecycleDto, AgentRunLifecycleEvent } from "@chamfer/shared";
import type { LlmStreamer } from "./llm";

type Env = Record<string, string | undefined>;

export interface LangfuseConfig {
  publicKey: string;
  secretKey: string;
  baseUrl: string;
}

export interface TraceObservation {
  id?: string;
  traceId?: string;
  update(attributes: Record<string, unknown>): void;
  end(endTime?: Date): void;
  startObservation(
    name: string,
    attributes?: Record<string, unknown>,
    options?: { asType?: "span" | "generation" | "event" | "agent" | "tool" | "chain" },
  ): TraceObservation;
}

type TraceRootFactory = (
  name: string,
  attributes?: Record<string, unknown>,
  options?: { asType?: "span" | "generation" | "event" | "agent" | "tool" | "chain"; startTime?: Date },
) => TraceObservation;

const noOpObservation: TraceObservation = {
  update() {},
  end() {},
  startObservation() { return noOpObservation; },
};

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
  const provider = new NodeTracerProvider({
    spanProcessors: [new LangfuseSpanProcessor({
      ...config,
      // Chamfer traces structural evidence, never raw prompt/output media. Disabling
      // media handling is defense in depth against an accidental future image field.
      mediaUploadEnabled: false,
      mask: maskLangfuseData,
      ...(env.LANGFUSE_RELEASE ? { release: env.LANGFUSE_RELEASE } : {}),
      ...(env.LANGFUSE_TRACING_ENVIRONMENT ? { environment: env.LANGFUSE_TRACING_ENVIRONMENT } : {}),
    })],
  });
  provider.register();
  flushOnShutdown(provider);
  console.log(`chamfer: langfuse tracing enabled (${config.baseUrl})`);
}

/** Final export guard for credential-shaped strings and local usernames in paths. */
export function maskLangfuseData({ data }: { data: unknown }): unknown {
  if (typeof data !== "string") return data;
  return data
    .replace(/\b(?:sk|pk)-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/((?:api[_-]?key|authorization|token|secret)["']?\s*[:=]\s*["']?)[^"',\s}]+/gi, "$1[REDACTED]")
    .replace(/\/Users\/[^/"'\\\s]+/g, "/Users/[REDACTED]")
    .replace(/\/home\/[^/"'\\\s]+/g, "/home/[REDACTED]");
}

interface GenerationInputSummary {
  messageCount: number;
  roles: { user: number; assistant: number; toolResult: number; system: number; other: number };
  textCharacters: number;
  imageCount: number;
  toolCallCount: number;
}

export function agentRunTraceAttributes(run: AgentRunLifecycleDto) {
  return {
    sessionId: langfuseSessionId(run.conversationId),
    traceName: "chamfer-agent-run",
    tags: run.evaluation ? ["agent-run", "evaluation"] : ["agent-run"],
    version: run.agentConfiguration.identityHash,
    metadata: {
      release: run.release,
      agentConfigurationName: run.agentConfiguration.name,
      agentConfigurationIdentityHash: run.agentConfiguration.identityHash,
      provider: run.agentConfiguration.provider,
      model: run.agentConfiguration.model,
      ...(run.evaluation ? {
        evaluationCaseExecutionId: run.evaluation.caseExecutionId,
        evaluationCaseId: run.evaluation.caseId,
        evaluationCorpusVersion: run.evaluation.corpusVersion,
        evaluationRepetition: String(run.evaluation.repetition),
      } : {}),
    },
  };
}

interface GenerationOutputSummary {
  blockCount: number;
  textCharacters: number;
  imageCount: number;
  toolCallCount: number;
  toolNames: string[];
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function contentBlocks(message: Record<string, unknown>): unknown[] {
  if (Array.isArray(message.content)) return message.content;
  return typeof message.content === "string" ? [{ type: "text", text: message.content }] : [];
}

function textLength(block: Record<string, unknown>): number {
  if (block.type === "text" && typeof block.text === "string") return block.text.length;
  if (block.type === "thinking" && typeof block.thinking === "string") return block.thinking.length;
  return 0;
}

/** Structural-only model input summary. It deliberately excludes every content body. */
export function summarizeGenerationInput(context: unknown): GenerationInputSummary {
  const messages = recordOf(context)?.messages;
  const list = Array.isArray(messages) ? messages : [];
  const summary: GenerationInputSummary = {
    messageCount: list.length,
    roles: { user: 0, assistant: 0, toolResult: 0, system: 0, other: 0 },
    textCharacters: 0,
    imageCount: 0,
    toolCallCount: 0,
  };
  for (const value of list) {
    const message = recordOf(value);
    if (!message) {
      summary.roles.other += 1;
      continue;
    }
    const role = message.role;
    if (role === "user" || role === "assistant" || role === "toolResult" || role === "system") {
      summary.roles[role] += 1;
    } else {
      summary.roles.other += 1;
    }
    for (const valueBlock of contentBlocks(message)) {
      const block = recordOf(valueBlock);
      if (!block) continue;
      summary.textCharacters += textLength(block);
      if (block.type === "image") summary.imageCount += 1;
      if (block.type === "toolCall") summary.toolCallCount += 1;
    }
  }
  return summary;
}

/** Structural-only model output summary. Tool names are bounded identifiers, never arguments. */
export function summarizeGenerationOutput(content: unknown): GenerationOutputSummary {
  const blocks = Array.isArray(content) ? content : [];
  const toolNames = new Set<string>();
  const summary: GenerationOutputSummary = {
    blockCount: blocks.length,
    textCharacters: 0,
    imageCount: 0,
    toolCallCount: 0,
    toolNames: [],
  };
  for (const value of blocks) {
    const block = recordOf(value);
    if (!block) continue;
    summary.textCharacters += textLength(block);
    if (block.type === "image") summary.imageCount += 1;
    if (block.type === "toolCall") {
      summary.toolCallCount += 1;
      const name = typeof block.name === "string" ? block.name : undefined;
      if (name && /^[A-Za-z0-9_-]{1,64}$/.test(name)) toolNames.add(name);
    }
  }
  summary.toolNames = [...toolNames].sort();
  return summary;
}

interface ActiveTrace {
  root: TraceObservation;
  run: AgentRunLifecycleDto;
  open: Map<string, { observation: TraceObservation; type: string; name?: string }>;
  activeTurnId?: string;
  cleanupTimer: ReturnType<typeof setTimeout>;
}

/** Server-owned bridge from durable browser lifecycle events into one Langfuse trace tree. */
export class AgentRunTraceManager {
  private readonly activeByRun = new Map<string, ActiveTrace>();
  private readonly activeRunByConversation = new Map<string, string>();

  private readonly abandonedRunTtlMs: number;
  private readonly maxActiveRuns: number;

  constructor(
    private readonly startRoot: TraceRootFactory = (name, attributes, options) =>
      startObservation(name, attributes, options as never) as unknown as TraceObservation,
    options: { abandonedRunTtlMs?: number; maxActiveRuns?: number } = {},
  ) {
    this.abandonedRunTtlMs = options.abandonedRunTtlMs ?? 30 * 60_000;
    this.maxActiveRuns = options.maxActiveRuns ?? 128;
  }

  private abandon(runId: string, trace: ActiveTrace, timestamp = Date.now()): void {
    clearTimeout(trace.cleanupTimer);
    for (const active of trace.open.values()) {
      active.observation.update({ level: "WARNING", statusMessage: "agent run trace abandoned" });
      active.observation.end(new Date(timestamp));
    }
    trace.root.update({ level: "WARNING", statusMessage: "agent run trace abandoned" });
    trace.root.end(new Date(timestamp));
    this.activeByRun.delete(runId);
    if (this.activeRunByConversation.get(trace.run.conversationId) === runId) {
      this.activeRunByConversation.delete(trace.run.conversationId);
    }
  }

  private touch(runId: string, trace: ActiveTrace): void {
    clearTimeout(trace.cleanupTimer);
    trace.cleanupTimer = setTimeout(() => this.abandon(runId, trace), this.abandonedRunTtlMs);
    trace.cleanupTimer.unref?.();
  }

  private enforceCapacity(): void {
    while (this.activeByRun.size >= this.maxActiveRuns) {
      const oldest = this.activeByRun.entries().next().value as [string, ActiveTrace] | undefined;
      if (!oldest) return;
      this.abandon(oldest[0], oldest[1]);
    }
  }

  private withIdentity<T>(run: AgentRunLifecycleDto, fn: () => T): T {
    return propagateAttributes(agentRunTraceAttributes(run), fn);
  }

  private child(
    trace: ActiveTrace,
    parent: TraceObservation,
    name: string,
    attributes: Record<string, unknown>,
    asType: "span" | "event" | "tool" | "chain",
  ): TraceObservation {
    return this.withIdentity(trace.run, () => parent.startObservation(name, attributes, { asType }));
  }

  record(
    run: AgentRunLifecycleDto,
    event: AgentRunLifecycleEvent,
  ): { traceId: string; observationId: string } | undefined {
    try {
      if (event.type === "run.started") {
        this.enforceCapacity();
        const root = this.withIdentity(run, () => this.startRoot(
          "chamfer-agent-run",
          {
            input: { conversationId: run.conversationId, evaluationCaseId: run.evaluation?.caseId },
            metadata: { contractVersion: String(run.version), release: run.release },
          },
          { asType: "agent", startTime: new Date(event.timestamp) },
        ));
        const cleanupTimer = setTimeout(() => {}, this.abandonedRunTtlMs);
        cleanupTimer.unref?.();
        const trace = { root, run, open: new Map(), cleanupTimer };
        this.activeByRun.set(run.id, trace);
        this.touch(run.id, trace);
        this.activeRunByConversation.set(run.conversationId, run.id);
        return typeof root.traceId === "string" && typeof root.id === "string"
          ? { traceId: root.traceId, observationId: root.id }
          : undefined;
      }
      const trace = this.activeByRun.get(run.id);
      if (!trace) return;
      this.touch(run.id, trace);
      trace.run = run;
      if (event.type === "turn.started" || event.type === "tool.started" || event.type === "compaction.started") {
        const name = event.type === "turn.started"
          ? "agent-turn"
          : event.type === "compaction.started"
            ? "context-compaction"
            : event.name === "run_build123d"
              ? "cad-execution"
              : "tool-call";
        const asType = event.type === "tool.started" ? "tool" : "chain";
        const observation = this.child(trace, trace.root, name, {
          metadata: {
            operationId: event.operationId,
            ...(event.type === "tool.started" ? { toolName: event.name } : {}),
          },
        }, asType);
        trace.open.set(event.operationId, { observation, type: event.type, ...(event.type === "tool.started" ? { name: event.name } : {}) });
        if (event.type === "turn.started") trace.activeTurnId = event.operationId;
        return;
      }
      if (event.type === "turn.completed" || event.type === "tool.completed" || event.type === "compaction.completed") {
        const active = trace.open.get(event.operationId);
        if (!active) return;
        active.observation.update({
          output: { outcome: event.outcome, durationMs: event.durationMs },
          ...(event.outcome === "ok" ? {} : { level: event.outcome === "error" ? "ERROR" : "WARNING" }),
        });
        active.observation.end(new Date(event.timestamp));
        trace.open.delete(event.operationId);
        if (trace.activeTurnId === event.operationId) trace.activeTurnId = undefined;
        return;
      }
      if (event.type === "retry.recorded" || event.type === "persistence.completed" || event.type === "persistence.failed") {
        const name = event.type === "retry.recorded" ? "provider-retry" : "message-persistence";
        const durationMs = event.type === "retry.recorded" ? event.delayMs : event.durationMs;
        const observation = this.child(trace, trace.root, name, {
          output: event.type === "retry.recorded"
            ? { attempt: event.attempt, delayMs: event.delayMs }
            : { outcome: event.type === "persistence.failed" ? "error" : "ok", durationMs },
          ...(event.type === "persistence.failed" ? { level: "ERROR" } : {}),
        }, event.type === "retry.recorded" ? "event" : "span");
        observation.end(new Date(event.timestamp));
        return;
      }
      if (event.type === "run.completed") {
        for (const active of trace.open.values()) {
          active.observation.update({ level: "WARNING", statusMessage: "operation incomplete when run ended" });
          active.observation.end(new Date(event.timestamp));
        }
        trace.root.update({
          output: { outcome: event.outcome, counters: run.counters, durations: run.durations },
          ...(event.outcome === "completed" ? {} : { level: event.outcome === "failed" ? "ERROR" : "WARNING" }),
        });
        trace.root.end(new Date(event.timestamp));
        clearTimeout(trace.cleanupTimer);
        this.activeByRun.delete(run.id);
        if (this.activeRunByConversation.get(run.conversationId) === run.id) {
          this.activeRunByConversation.delete(run.conversationId);
        }
      }
    } catch {
      // Langfuse and OTel are always best effort. Durable state remains authoritative.
    }
    return undefined;
  }

  startGeneration(conversationId: string, name: string, attributes: Record<string, unknown>): TraceObservation {
    try {
      const runId = this.activeRunByConversation.get(conversationId);
      const trace = runId ? this.activeByRun.get(runId) : undefined;
      if (!trace) return startObservation(name, attributes as never, { asType: "generation" }) as unknown as TraceObservation;
      this.touch(runId!, trace);
      const turn = trace.activeTurnId ? trace.open.get(trace.activeTurnId)?.observation : undefined;
      return this.withIdentity(trace.run, () => (turn ?? trace.root).startObservation(name, attributes, { asType: "generation" }));
    } catch {
      return noOpObservation;
    }
  }
}

/**
 * Spans export in batches, so the last few LLM calls would be lost when the
 * user Ctrl-C's the server. Flush before exiting, bounded so an unreachable
 * Langfuse host can never keep the process alive.
 */
function flushOnShutdown(provider: NodeTracerProvider): void {
  const flushThenExit = (code: number) => () => {
    void shutdownObservability(provider).finally(() => process.exit(code));
  };
  process.once("SIGINT", flushThenExit(130));
  process.once("SIGTERM", flushThenExit(143));
}

/** Flushes pending spans without allowing an exporter outage to hold shutdown open. */
export async function shutdownObservability(
  provider: Pick<NodeTracerProvider, "shutdown">,
  timeoutMs = 2_000,
): Promise<"shutdown" | "timeout"> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timeout = setTimeout(() => resolve("timeout"), timeoutMs);
    timeout.unref?.();
  });
  try {
    return await Promise.race([
      provider.shutdown().then(() => "shutdown" as const).catch(() => "shutdown" as const),
      deadline,
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/**
 * Wraps an LlmStreamer so each stream() call becomes a Langfuse generation
 * named after its call site (e.g. "chat-response", "conversation-title"),
 * carrying the request context, the completed output, token usage, and cost.
 * Events pass through unchanged. `options` is deliberately never recorded:
 * it carries API keys (apiKey/env). A no-op when no tracer provider is
 * registered, so it is safe to install unconditionally.
 */
export function observeLlm(llm: LlmStreamer, name: string, traceManager?: AgentRunTraceManager): LlmStreamer {
  return {
    async *stream(model, context, options) {
      const provider = stringField(model, "provider");
      const sessionId = langfuseSessionId(options.sessionId);
      const createGeneration = () =>
        traceManager && sessionId
          ? traceManager.startGeneration(sessionId, name, {
              model: stringField(model, "id"),
              input: summarizeGenerationInput(context),
              ...(provider ? { metadata: { provider } } : {}),
            })
          : startObservation(
              name,
              {
                model: stringField(model, "id"),
                input: summarizeGenerationInput(context),
                ...(provider ? { metadata: { provider } } : {}),
              },
              { asType: "generation" },
            ) as unknown as TraceObservation;
      let generation: TraceObservation;
      try {
        generation = sessionId
          ? propagateAttributes({ sessionId }, createGeneration)
          : createGeneration();
      } catch {
        generation = noOpObservation;
      }
      try {
        for await (const event of llm.stream(model, context, options)) {
          if (event.type === "done") {
            generation.update({
              output: summarizeGenerationOutput(event.message.content),
              ...usageAttributes(event.message.usage),
            });
          } else if (event.type === "error") {
            generation.update({
              level: event.error.stopReason === "aborted" ? "WARNING" : "ERROR",
              statusMessage: event.error.stopReason === "aborted" ? "provider stream aborted" : "provider stream failed",
              ...usageAttributes(event.error.usage),
            });
          }
          yield event;
        }
      } catch (e) {
        generation.update({ level: "ERROR", statusMessage: "provider stream threw" });
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
