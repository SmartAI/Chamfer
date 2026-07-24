import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { openDb } from "../db";
import { feedbackRoutes } from "./feedback";

function setup(scoreSink?: { upsertScore: ReturnType<typeof vi.fn> }) {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run("conversation-1", "Test", 1, 1);
  db.prepare(`INSERT INTO agent_runs
    (id, conversation_id, status, outcome, started_at, completed_at, total_duration_ms, release,
     agent_configuration_json, evaluation_json, last_seq, counters_json, durations_json)
    VALUES (?, ?, 'completed', 'completed', ?, ?, ?, ?, ?, NULL, ?, ?, ?)`)
    .run(
      "run-1",
      "conversation-1",
      10,
      20,
      10,
      "0.2.2",
      JSON.stringify({ name: "current", identityHash: "a".repeat(64), provider: "fixture", model: "fixture" }),
      1,
      JSON.stringify({}),
      JSON.stringify({}),
    );
  db.prepare("INSERT INTO agent_run_trace_refs (run_id, trace_id, observation_id) VALUES (?, ?, ?)")
    .run("run-1", "trace-1", "observation-1");
  const app = new Hono();
  app.route("/", feedbackRoutes(db, { scoreSink: scoreSink as never, syncDeadlineMs: 50 }));
  return { db, app };
}

describe("result feedback", () => {
  it("persists an idempotent rating and targets the exact evidence observation", async () => {
    const upsertScore = vi.fn().mockResolvedValue(undefined);
    const { app } = setup({ upsertScore });
    const first = await app.request("/api/conversations/conversation-1/agent-runs/run-1/feedback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rating: "positive" }),
    });
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({ rating: "positive", syncStatus: "synced" });
    expect(upsertScore).toHaveBeenCalledWith(expect.objectContaining({
      traceId: "trace-1",
      observationId: "observation-1",
      name: "user-thumbs",
      value: 1,
      dataType: "BOOLEAN",
    }), expect.any(AbortSignal));

    const repeated = await app.request("/api/conversations/conversation-1/agent-runs/run-1/feedback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rating: "positive" }),
    });
    expect(repeated.status).toBe(200);
    expect(upsertScore).toHaveBeenCalledTimes(1);
  });

  it("rejects a stale result after a newer run exists", async () => {
    const { db, app } = setup();
    db.prepare(`INSERT INTO agent_runs
      (id, conversation_id, status, started_at, release, agent_configuration_json, last_seq, counters_json, durations_json)
      VALUES (?, ?, 'running', ?, ?, ?, ?, ?, ?)`)
      .run("run-2", "conversation-1", 30, "0.2.2", JSON.stringify({ identityHash: "b".repeat(64) }), 0, "{}", "{}");
    const response = await app.request("/api/conversations/conversation-1/agent-runs/run-1/feedback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rating: "negative" }),
    });
    expect(response.status).toBe(409);
  });

  it("keeps a Langfuse outage isolated from the locally accepted rating", async () => {
    const upsertScore = vi.fn().mockRejectedValue(new Error("offline"));
    const { app, db } = setup({ upsertScore });
    const response = await app.request("/api/conversations/conversation-1/agent-runs/run-1/feedback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rating: "negative" }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ rating: "negative", syncStatus: "unavailable" });
    expect(db.prepare("SELECT reasons_json FROM online_review_inventory WHERE run_id = ?").get("run-1"))
      .toEqual({ reasons_json: JSON.stringify(["explicit-negative-feedback"]) });
  });
});
