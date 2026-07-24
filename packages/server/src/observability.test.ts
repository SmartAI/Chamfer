import { describe, expect, it, vi } from "vitest";
import {
  AgentRunTraceManager,
  agentRunTraceAttributes,
  langfuseConfig,
  langfuseSessionId,
  maskLangfuseData,
  observeLlm,
  summarizeGenerationInput,
  summarizeGenerationOutput,
  shutdownObservability,
  usageAttributes,
  type TraceObservation,
} from "./observability";
import type { AgentRunLifecycleDto, AgentRunLifecycleEvent } from "@chamfer/shared";
import type { LlmStreamer, PiEvent } from "./llm";

const usage = {
  input: 8,
  output: 12,
  cacheRead: 3,
  cacheWrite: 1,
  totalTokens: 24,
  cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02, total: 0.33 },
};

async function collect(iterable: AsyncIterable<PiEvent>): Promise<PiEvent[]> {
  const events: PiEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe("langfuseConfig", () => {
  it("is undefined when either key is missing", () => {
    expect(langfuseConfig({})).toBeUndefined();
    expect(langfuseConfig({ LANGFUSE_PUBLIC_KEY: "pk" })).toBeUndefined();
    expect(langfuseConfig({ LANGFUSE_SECRET_KEY: "sk" })).toBeUndefined();
  });

  it("defaults the base URL to Langfuse Cloud", () => {
    expect(langfuseConfig({ LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "sk" })).toEqual({
      publicKey: "pk",
      secretKey: "sk",
      baseUrl: "https://cloud.langfuse.com",
    });
  });

  it("honors LANGFUSE_BASE_URL", () => {
    const env = {
      LANGFUSE_PUBLIC_KEY: "pk",
      LANGFUSE_SECRET_KEY: "sk",
      LANGFUSE_BASE_URL: "https://langfuse.internal.example",
    };
    expect(langfuseConfig(env)?.baseUrl).toBe("https://langfuse.internal.example");
  });
});

describe("observeLlm", () => {
  // No OTel provider is registered in tests, so startObservation produces
  // non-recording spans; these tests pin the wire behavior of the wrapper.
  it("passes all events through unchanged and in order", async () => {
    const scripted: LlmStreamer = {
      async *stream() {
        yield { type: "start", partial: {} } as never;
        yield { type: "text_delta", contentIndex: 0, delta: "hello", partial: {} } as never;
        yield { type: "done", message: { stopReason: "stop", content: [{ type: "text", text: "hello" }], usage } } as never;
      },
    };
    const events = await collect(observeLlm(scripted, "chat-response").stream({}, { messages: [] }, {}));
    expect(events.map((e) => e.type)).toEqual(["start", "text_delta", "done"]);
    expect(events[1]).toMatchObject({ delta: "hello" });
  });

  it("passes error events through and keeps their usage", async () => {
    const erroring: LlmStreamer = {
      async *stream() {
        yield { type: "error", error: { stopReason: "error", errorMessage: "boom", usage } } as never;
      },
    };
    const events = await collect(observeLlm(erroring, "chat-response").stream({}, { messages: [] }, {}));
    expect(events).toEqual([{ type: "error", error: { stopReason: "error", errorMessage: "boom", usage } }]);
  });

  it("propagates a mid-stream throw", async () => {
    const throwing: LlmStreamer = {
      async *stream() {
        yield { type: "start", partial: {} } as never;
        throw new Error("upstream exploded");
      },
    };
    await expect(collect(observeLlm(throwing, "chat-response").stream({}, {}, {}))).rejects.toThrow("upstream exploded");
  });

  it("forwards model, context, and options to the wrapped streamer", async () => {
    const seen: unknown[] = [];
    const recording: LlmStreamer = {
      async *stream(model, context, options) {
        seen.push(model, context, options);
        yield { type: "done", message: { stopReason: "stop", content: [], usage } } as never;
      },
    };
    const model = { id: "gpt-5", provider: "openai" };
    const context = { messages: [] };
    const options = { apiKey: "sk-secret" };
    await collect(observeLlm(recording, "chat-response").stream(model, context, options));
    expect(seen).toEqual([model, context, options]);
  });
});

describe("privacy-safe generation summaries", () => {
  it("records structure without prompt text, image bytes, CAD code, or model output", () => {
    const secret = "sk-secret-value";
    const input = summarizeGenerationInput({
      messages: [
        { role: "user", content: [{ type: "text", text: `private ${secret}` }, { type: "image", data: "base64-private", mimeType: "image/png" }] },
        { role: "toolResult", content: [{ type: "text", text: "/Users/private/design.step" }] },
      ],
    });
    const output = summarizeGenerationOutput([
      { type: "thinking", thinking: "private reasoning" },
      { type: "text", text: "private answer" },
      { type: "toolCall", name: "run_build123d", arguments: { code: "private CAD code" } },
    ]);
    expect(input).toEqual({ messageCount: 2, roles: { user: 1, assistant: 0, toolResult: 1, system: 0, other: 0 }, textCharacters: 49, imageCount: 1, toolCallCount: 0 });
    expect(output).toEqual({ blockCount: 3, textCharacters: 31, imageCount: 0, toolCallCount: 1, toolNames: ["run_build123d"] });
    expect(JSON.stringify({ input, output })).not.toMatch(/sk-secret|base64-private|Users|private answer|private CAD/);
  });

  it("masks credential-shaped values and local user paths before export", () => {
    const masked = maskLangfuseData({
      data: '{"authorization":"Bearer abc.def.secret","apiKey":"sk-1234567890","path":"/Users/bob/private.step","home":"/home/alice/x"}',
    });
    expect(masked).not.toMatch(/abc\.def\.secret|sk-1234567890|\/Users\/bob|\/home\/alice/);
    expect(masked).toContain("[REDACTED]");
  });
});

describe("complete agent-run trace hierarchy", () => {
  it("parents a model generation and tool observation beneath the stable agent run", () => {
    const recorded: Array<{ name: string; parent?: string; ended?: boolean }> = [];
    const observation = (name: string, parent?: string): TraceObservation => {
      const item = { name, parent, ended: false };
      recorded.push(item);
      return {
        update() {},
        end() { item.ended = true; },
        startObservation(childName) { return observation(childName, name); },
      };
    };
    const manager = new AgentRunTraceManager((name) => observation(name));
    const run: AgentRunLifecycleDto = {
      version: 1,
      id: "run-1",
      conversationId: "conversation-1",
      status: "running",
      startedAt: 1_000,
      release: "v0.2.2",
      agentConfiguration: { name: "current", identityHash: "a".repeat(64), provider: "openai", model: "gpt-5" },
      lastSeq: 0,
      counters: { modelCalls: 0, toolCalls: 0, cadRuns: 0, retries: 0, compactions: 0, persistenceFailures: 0, searches: 0, skillLoads: 0 },
      durations: { modelMs: 0, toolMs: 0, cadMs: 0, compactionMs: 0, persistenceMs: 0, retryDelayMs: 0 },
    };
    const event = (value: Record<string, unknown>, seq: number, timestamp: number) =>
      ({ version: 1, runId: run.id, seq, timestamp, ...value }) as AgentRunLifecycleEvent;
    expect(agentRunTraceAttributes(run)).toMatchObject({
      version: "a".repeat(64),
      metadata: {
        agentConfigurationName: "current",
        agentConfigurationIdentityHash: "a".repeat(64),
      },
    });
    manager.record(run, event({ type: "run.started", agentConfiguration: run.agentConfiguration }, 0, 1_000));
    manager.record(run, event({ type: "turn.started", operationId: "turn-1" }, 1, 1_010));
    const generation = manager.startGeneration(run.conversationId, "chat-response", {});
    generation.end();
    manager.record(run, event({ type: "tool.started", operationId: "tool-1", name: "run_build123d" }, 2, 1_020));
    manager.record(run, event({ type: "tool.completed", operationId: "tool-1", outcome: "ok", durationMs: 20 }, 3, 1_040));
    manager.record({ ...run, status: "completed", outcome: "completed" }, event({ type: "run.completed", outcome: "completed", durationMs: 50 }, 4, 1_050));

    expect(recorded.map(({ name, parent }) => [name, parent])).toEqual([
      ["chamfer-agent-run", undefined],
      ["agent-turn", "chamfer-agent-run"],
      ["chat-response", "agent-turn"],
      ["cad-execution", "chamfer-agent-run"],
    ]);
    expect(recorded.filter((item) => item.ended).map((item) => item.name)).toEqual([
      "chamfer-agent-run",
      "agent-turn",
      "chat-response",
      "cad-execution",
    ]);
  });

  it("ends and evicts an abandoned browser run after a bounded idle TTL", async () => {
    vi.useFakeTimers();
    const roots: Array<{ ended: boolean }> = [];
    const manager = new AgentRunTraceManager(() => {
      const root = { ended: false };
      roots.push(root);
      const observation: TraceObservation = {
        update() {},
        end() { root.ended = true; },
        startObservation() { return observation; },
      };
      return observation;
    }, { abandonedRunTtlMs: 25, maxActiveRuns: 2 });
    const run: AgentRunLifecycleDto = {
      version: 1,
      id: "abandoned-run",
      conversationId: "conversation-1",
      status: "running",
      startedAt: 1_000,
      release: "test",
      agentConfiguration: { name: "current", identityHash: "a".repeat(64), provider: "openai", model: "gpt-5" },
      lastSeq: 0,
      counters: { modelCalls: 0, toolCalls: 0, cadRuns: 0, retries: 0, compactions: 0, persistenceFailures: 0, searches: 0, skillLoads: 0 },
      durations: { modelMs: 0, toolMs: 0, cadMs: 0, compactionMs: 0, persistenceMs: 0, retryDelayMs: 0 },
    };
    manager.record(run, { version: 1, runId: run.id, seq: 0, timestamp: 1_000, type: "run.started", agentConfiguration: run.agentConfiguration });
    expect(roots[0]?.ended).toBe(false);
    await vi.advanceTimersByTimeAsync(25);
    expect(roots[0]?.ended).toBe(true);
    vi.useRealTimers();
  });
});

describe("bounded observability shutdown", () => {
  it("settles at the deadline when the exporter never responds", async () => {
    vi.useFakeTimers();
    const result = shutdownObservability({ shutdown: () => new Promise(() => {}) }, 25);
    await vi.advanceTimersByTimeAsync(25);
    await expect(result).resolves.toBe("timeout");
    vi.useRealTimers();
  });
});

describe("usage mapping", () => {
  it("maps pi-ai usage and cost to Langfuse usageDetails/costDetails", () => {
    expect(usageAttributes(usage)).toEqual({
      usageDetails: {
        input: 8,
        output: 12,
        cache_read_input_tokens: 3,
        cache_creation_input_tokens: 1,
        total: 24,
      },
      costDetails: {
        input: 0.1,
        output: 0.2,
        cache_read_input_tokens: 0.01,
        cache_creation_input_tokens: 0.02,
        total: 0.33,
      },
    });
    expect(usageAttributes({ ...usage, reasoning: 5 }).usageDetails?.reasoning).toBe(5);
  });

  it("tolerates events without usage so tracing can never fail a stream", () => {
    expect(usageAttributes(undefined)).toEqual({});
    expect(usageAttributes({ ...usage, cost: undefined } as never)).toEqual({
      usageDetails: expect.objectContaining({ input: 8, output: 12 }),
    });
  });

  it("records a done event that carries no usage without breaking the stream", async () => {
    const bareDone: LlmStreamer = {
      async *stream() {
        yield { type: "done", message: { stopReason: "stop", content: [{ type: "text", text: "hi" }] } } as never;
      },
    };
    const events = await collect(observeLlm(bareDone, "conversation-title").stream({}, {}, {}));
    expect(events.map((e) => e.type)).toEqual(["done"]);
  });
});

describe("langfuseSessionId", () => {
  it("accepts conversation IDs that satisfy Langfuse's session contract", () => {
    expect(langfuseSessionId("conversation-123")).toBe("conversation-123");
  });

  it("rejects empty, non-ASCII, and 200-character IDs", () => {
    expect(langfuseSessionId(123)).toBeUndefined();
    expect(langfuseSessionId("")).toBeUndefined();
    expect(langfuseSessionId("conversation-\u2603")).toBeUndefined();
    expect(langfuseSessionId("x".repeat(200))).toBeUndefined();
  });
});
