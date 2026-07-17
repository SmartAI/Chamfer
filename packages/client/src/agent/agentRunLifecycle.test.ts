import { describe, expect, it, vi } from "vitest";
import type { AgentRunLifecycleBatch } from "@chamfer/shared";
import {
  AgentRunReporter,
  createAgentConfigurationTraceIdentity,
  evaluationTraceIdentity,
} from "./agentRunLifecycle";

describe("AgentRunReporter", () => {
  it("delivers ordered bounded lifecycle batches and completes with aggregate-ready operations", async () => {
    const batches: AgentRunLifecycleBatch[] = [];
    let now = 1_000;
    const reporter = new AgentRunReporter({
      conversationId: "conversation-1",
      configuration: { identityHash: "a".repeat(64), provider: "openai", model: "gpt-5", skillMode: "catalog" },
      now: () => now,
      randomUUID: () => "11111111-1111-4111-8111-111111111111",
      postEvents: async (_conversationId, _runId, batch) => { batches.push(batch); },
      deadlineMs: 50,
    });

    await reporter.start();
    now = 1_010;
    await reporter.operationStarted("turn", "turn-1");
    reporter.operationStarted("tool", "tool-1", "run_build123d");
    now = 1_040;
    reporter.operationCompleted("tool", "tool-1", "ok", 30);
    reporter.recordRetry(1, 250);
    now = 1_100;
    reporter.operationCompleted("turn", "turn-1", "ok", 90);
    reporter.recordPersistence("message-1", false, 5);
    await reporter.finish("completed");

    const events = batches.flatMap((batch) => batch.events);
    expect(events.map((event) => [event.seq, event.type])).toEqual([
      [0, "run.started"],
      [1, "turn.started"],
      [2, "tool.started"],
      [3, "tool.completed"],
      [4, "retry.recorded"],
      [5, "turn.completed"],
      [6, "persistence.failed"],
      [7, "run.completed"],
    ]);
    expect(events.every((event) => event.runId === reporter.runId && event.version === 1)).toBe(true);
  });

  it("isolates a hanging ingestion endpoint within the deadline and disables later sends", async () => {
    vi.useFakeTimers();
    const postEvents = vi.fn((_conversationId, _runId, _batch, signal?: AbortSignal) =>
      new Promise<void>((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")))));
    const reporter = new AgentRunReporter({
      conversationId: "conversation-1",
      configuration: { identityHash: "a".repeat(64), provider: "openai", model: "gpt-5", skillMode: "catalog" },
      postEvents,
      deadlineMs: 25,
    });
    const started = reporter.start();
    await vi.advanceTimersByTimeAsync(25);
    await expect(started).resolves.toBeUndefined();
    reporter.recordRetry(1, 100);
    await reporter.finish("completed");
    expect(postEvents).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("drops already queued batches after a mid-run outage instead of paying one deadline per event", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const postEvents = vi.fn((_conversationId, _runId, _batch, signal?: AbortSignal) => {
      calls += 1;
      if (calls === 1) return Promise.resolve();
      return new Promise<void>((_resolve, reject) =>
        signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    });
    const reporter = new AgentRunReporter({
      conversationId: "conversation-1",
      configuration: { identityHash: "a".repeat(64), provider: "openai", model: "gpt-5", skillMode: "catalog" },
      postEvents,
      deadlineMs: 25,
    });
    await reporter.start();
    void reporter.operationStarted("turn", "turn-1");
    reporter.recordRetry(1, 1);
    reporter.recordRetry(2, 1);
    const finished = reporter.finish("failed");
    await vi.advanceTimersByTimeAsync(25);
    await expect(finished).resolves.toBeUndefined();
    expect(postEvents).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});

describe("agent configuration trace identity", () => {
  it("hashes behavior-affecting inputs without returning their bodies", async () => {
    const identity = await createAgentConfigurationTraceIdentity({
      modelJson: JSON.stringify({ provider: "openai", id: "gpt-5", apiKey: "must-not-escape" }),
      systemPrompt: "private system prompt",
      toolNames: ["search_docs", "run_build123d"],
      skillMode: "catalog",
      maxCadRuns: 10,
    });
    expect(identity).toMatchObject({ provider: "openai", model: "gpt-5", skillMode: "catalog" });
    expect(identity.identityHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(identity)).not.toMatch(/private system|must-not-escape|search_docs/);
  });
});

it("accepts a complete bounded evaluation URL identity and rejects partial identity", () => {
  expect(evaluationTraceIdentity("?evaluationCaseExecutionId=exec-1&evaluationCaseId=precise-box&evaluationCorpusVersion=1.0.0&evaluationRepetition=2"))
    .toEqual({ caseExecutionId: "exec-1", caseId: "precise-box", corpusVersion: "1.0.0", repetition: 2 });
  expect(evaluationTraceIdentity("?evaluationCaseId=precise-box")).toBeUndefined();
});
