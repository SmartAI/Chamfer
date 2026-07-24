import { describe, expect, it } from "vitest";
import { openDb } from "../db";
import { recordCompletedRunMonitoring } from "./onlineMonitoring";
import { AGENT_EVALUATION_PILLARS, type AgentConfigurationIdentity, type AgentRunLifecycleDto } from "@chamfer/shared";
import { createApp } from "../app";

function run(id: string, release = "0.2.2"): AgentRunLifecycleDto {
  return {
    version: 1,
    id,
    conversationId: "conversation-1",
    status: "completed",
    outcome: "completed",
    startedAt: 1,
    completedAt: 101,
    totalDurationMs: 100,
    release,
    agentConfiguration: {
      name: "current",
      identityHash: "a".repeat(64),
      provider: "fixture",
      model: "fixture-model",
    },
    lastSeq: 1,
    counters: {
      modelCalls: 1,
      toolCalls: 1,
      cadRuns: 1,
      retries: 0,
      compactions: 0,
      persistenceFailures: 0,
      searches: 0,
      skillLoads: 0,
    },
    durations: {
      modelMs: 50,
      toolMs: 40,
      cadMs: 40,
      compactionMs: 0,
      persistenceMs: 10,
      retryDelayMs: 0,
    },
  };
}

describe("production online monitoring persistence", () => {
  it("records a trend-ready score and samples the first observed release without claiming task success", () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO conversations (id, title, created_at, updated_at, last_gate_status) VALUES (?, ?, ?, ?, ?)")
      .run("conversation-1", "Test", 1, 1, "passed");
    const result = recordCompletedRunMonitoring(db, run("run-1"));
    const benchmarkIdentity: AgentConfigurationIdentity = {
      name: "current",
      identityHash: "a".repeat(64),
    };
    expect(result?.score.configuration).toEqual(benchmarkIdentity);
    expect(result?.score.pillars.taskSuccess).toEqual({ passed: null, status: "unavailable" });
    expect(Object.keys(result!.score.pillars)).toEqual(AGENT_EVALUATION_PILLARS);
    expect(result?.review?.reasons).toEqual(["new-release"]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM online_run_scores").get()).toEqual({ count: 1 });
  });

  it("records identity-bearing unavailable evidence when conversation context is missing", () => {
    const db = openDb(":memory:");
    expect(recordCompletedRunMonitoring(db, run("missing-conversation"))?.score).toMatchObject({
      configuration: { name: "current", identityHash: "a".repeat(64) },
      pillars: { gateIntegrity: { passed: null } },
    });
  });

  it("derives provider cost and plan completion from persisted structured records", () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO conversations (id, title, created_at, updated_at, last_gate_status) VALUES (?, ?, ?, ?, ?)")
      .run("conversation-1", "Test", 1, 1, "passed");
    db.prepare(`INSERT INTO messages (id, conversation_id, seq, role, content_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)`).run(
      "assistant-1", "conversation-1", 0, "assistant",
      JSON.stringify({ role: "assistant", usage: { cost: { total: 1.25 } } }), 1,
      "plan-1", "conversation-1", 1, "toolResult",
      JSON.stringify({
        role: "toolResult",
        toolName: "update_plan",
        isError: false,
        details: { plan: { components: [{ status: "done" }] } },
      }), 2,
    );

    const result = recordCompletedRunMonitoring(db, run("run-cost"), {
      version: 1,
      randomSampleRate: 0,
      maximumReviewItems: 10,
      unusualCost: 1,
      unusualLatencyMs: 1_000,
      toolErrorCluster: 3,
      repeatedCadFailures: 2,
    });

    expect(result?.score).toMatchObject({
      pillars: { cost: { providerCostUsd: 1.25 }, taskSuccess: { passed: null, status: "unavailable" } },
      diagnostics: { planCompleted: true },
    });
    expect(result?.review?.reasons).toContain("unusual-cost");
  });

  it("records monitoring after the durable lifecycle completion route settles", async () => {
    const db = openDb(":memory:");
    const app = createApp(db, undefined, { release: "0.2.2" });
    const conversationResponse = await app.request("/api/conversations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Monitored", cadEnvironment: "build123d" }),
    });
    const conversation = await conversationResponse.json() as { id: string };
    const completed = run("run-route");
    const response = await app.request(`/api/conversations/${conversation.id}/agent-runs/${completed.id}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        events: [
          {
            version: 1,
            runId: completed.id,
            seq: 0,
            timestamp: 1,
            type: "run.started",
            agentConfiguration: completed.agentConfiguration,
          },
          {
            version: 1,
            runId: completed.id,
            seq: 1,
            timestamp: 101,
            type: "run.completed",
            outcome: "completed",
            durationMs: 100,
          },
        ],
      }),
    });

    expect(response.status).toBe(200);
    expect(db.prepare("SELECT run_id FROM online_run_scores").all()).toEqual([{ run_id: completed.id }]);
  });
});
