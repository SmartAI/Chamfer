import { describe, expect, it } from "vitest";
import { mergeLifecycleMeasurements } from "./lifecycleMeasurements";

describe("evaluation lifecycle measurements", () => {
  it("prefers durable aggregate counters and durations over message-derived estimates", () => {
    const merged = mergeLifecycleMeasurements({
      measurements: {
        cadRuns: 1,
        modelCalls: 1,
        toolCalls: 1,
        toolErrors: 0,
        searches: 0,
        skillLoads: 0,
        retries: 0,
        compactions: 0,
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        providerCost: 0.01,
      },
      lifecycle: {
        status: "completed",
        counters: {
          modelCalls: 3,
          toolCalls: 7,
          cadRuns: 2,
          retries: 1,
          compactions: 1,
          persistenceFailures: 0,
          searches: 2,
          skillLoads: 1,
        },
        durations: {
          modelMs: 100,
          toolMs: 200,
          cadMs: 150,
          compactionMs: 30,
          persistenceMs: 20,
          retryDelayMs: 500,
        },
      },
    });
    expect(merged).toMatchObject({
      modelCalls: 3,
      toolCalls: 7,
      cadRuns: 2,
      retries: 1,
      compactions: 1,
      searches: 2,
      skillLoads: 1,
      modelLatencyMs: 100,
      toolLatencyMs: 200,
      cadLatencyMs: 150,
      compactionLatencyMs: 30,
      persistenceLatencyMs: 20,
      retryDelayMs: 500,
      persistenceFailures: 0,
    });
  });

  it("rejects lifecycle evidence that has not reached its durable completion barrier", () => {
    expect(() => mergeLifecycleMeasurements({
      measurements: {} as never,
      lifecycle: { status: "running", counters: {} as never, durations: {} as never },
    })).toThrow(/completion barrier/i);
  });
});
