import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import type { ScorePayload } from "../evaluation/langfuseExperimentSync";
import { addOnlineReviewReason } from "../evaluation/onlineMonitoring";

const SCORE_NAME = "user-thumbs";
const SCORE_PROVENANCE = "explicit-user-v1";

interface ScoreSink {
  upsertScore(payload: ScorePayload, signal?: AbortSignal): Promise<void>;
}

interface RunRow {
  id: string;
  conversation_id: string;
  status: string;
  release: string;
  agent_configuration_json: string;
  trace_id: string | null;
  observation_id: string | null;
}

interface FeedbackRow {
  id: string;
  rating: "positive" | "negative";
  created_at: number;
  sync_status: "synced" | "unavailable" | "pending";
}

function feedbackId(conversationId: string, runId: string): string {
  return createHash("sha256").update(`${conversationId}\0${runId}\0${SCORE_NAME}`).digest("hex").slice(0, 32);
}

function response(row: FeedbackRow) {
  return {
    rating: row.rating,
    createdAt: row.created_at,
    syncStatus: row.sync_status === "pending" ? "unavailable" : row.sync_status,
  };
}

async function syncScore(
  sink: ScoreSink,
  payload: ScorePayload,
  deadlineMs: number,
): Promise<"synced" | "unavailable"> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), deadlineMs);
  try {
    await Promise.race([
      sink.upsertScore(payload, controller.signal),
      new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener("abort", () => reject(new Error("feedback synchronization timed out")));
      }),
    ]);
    return "synced";
  } catch {
    return "unavailable";
  } finally {
    clearTimeout(timeout);
  }
}

export function feedbackRoutes(db: DatabaseSync, options: {
  scoreSink?: ScoreSink;
  syncDeadlineMs?: number;
} = {}): Hono {
  const app = new Hono();
  app.post("/api/conversations/:id/agent-runs/:runId/feedback", async (c) => {
    const body = await c.req.json<{ rating?: unknown }>().catch(() => undefined);
    if (body?.rating !== "positive" && body?.rating !== "negative") {
      return c.json({ error: "rating must be positive or negative" }, 400);
    }
    const conversationId = c.req.param("id");
    const runId = c.req.param("runId");
    const run = db.prepare(`SELECT r.*, refs.trace_id, refs.observation_id
      FROM agent_runs r LEFT JOIN agent_run_trace_refs refs ON refs.run_id = r.id
      WHERE r.id = ? AND r.conversation_id = ?`).get(runId, conversationId) as unknown as RunRow | undefined;
    if (!run) return c.json({ error: "not found" }, 404);
    const latest = db.prepare(`SELECT id FROM agent_runs WHERE conversation_id = ?
      ORDER BY started_at DESC, rowid DESC LIMIT 1`).get(conversationId) as { id: string } | undefined;
    if (latest?.id !== runId || run.status !== "completed") {
      return c.json({ error: "feedback target is stale or incomplete" }, 409);
    }
    const existing = db.prepare(`SELECT id, rating, created_at, sync_status FROM agent_run_feedback
      WHERE conversation_id = ? AND run_id = ? AND score_name = ?`)
      .get(conversationId, runId, SCORE_NAME) as unknown as FeedbackRow | undefined;
    if (existing) {
      if (existing.rating !== body.rating) return c.json({ error: "feedback already recorded" }, 409);
      return c.json(response(existing), 200);
    }
    const configuration = JSON.parse(run.agent_configuration_json) as { identityHash?: string };
    const id = feedbackId(conversationId, runId);
    const createdAt = Date.now();
    db.prepare(`INSERT INTO agent_run_feedback
      (id, conversation_id, run_id, rating, release, agent_configuration_hash, score_name,
       score_provenance, created_at, sync_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`)
      .run(
        id,
        conversationId,
        runId,
        body.rating,
        run.release,
        configuration.identityHash ?? "unknown",
        SCORE_NAME,
        SCORE_PROVENANCE,
        createdAt,
      );
    let syncStatus: FeedbackRow["sync_status"] = "unavailable";
    if (options.scoreSink && run.trace_id && run.observation_id) {
      syncStatus = await syncScore(options.scoreSink, {
        id,
        traceId: run.trace_id,
        observationId: run.observation_id,
        name: SCORE_NAME,
        value: body.rating === "positive" ? 1 : 0,
        dataType: "BOOLEAN",
        metadata: {
          provenance: SCORE_PROVENANCE,
          release: run.release,
          agentConfigurationHash: configuration.identityHash ?? "unknown",
        },
        environment: "production",
      }, options.syncDeadlineMs ?? 500);
    }
    db.prepare("UPDATE agent_run_feedback SET sync_status = ? WHERE id = ?").run(syncStatus, id);
    if (body.rating === "negative") addOnlineReviewReason(db, runId, "explicit-negative-feedback");
    return c.json(response({ id, rating: body.rating, created_at: createdAt, sync_status: syncStatus }), 201);
  });
  return app;
}
