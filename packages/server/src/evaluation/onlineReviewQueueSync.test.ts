import { describe, expect, it, vi } from "vitest";
import { openDb } from "../db";
import { syncOnlineReviewInventory } from "./onlineReviewQueueSync";

function setup() {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run("conversation-1", "Review", 1, 1);
  db.prepare(`INSERT INTO agent_runs
    (id, conversation_id, status, outcome, started_at, completed_at, release,
     agent_configuration_json, last_seq, counters_json, durations_json)
    VALUES (?, ?, 'completed', 'completed', ?, ?, ?, ?, ?, ?, ?)`).run(
    "run-1",
    "conversation-1",
    1,
    2,
    "0.2.2",
    JSON.stringify({ name: "current", identityHash: "a".repeat(64), provider: "fixture", model: "fixture" }),
    1,
    "{}",
    "{}",
  );
  db.prepare("INSERT INTO agent_run_trace_refs (run_id, trace_id, observation_id) VALUES (?, ?, ?)")
    .run("run-1", "trace-1", "observation-1");
  db.prepare(`INSERT INTO online_run_scores
    (run_id, release, agent_configuration_hash, provider, model, modality,
     score_provenance, score_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    "run-1", "0.2.2", "a".repeat(64), "fixture", "fixture", "text",
    "online-deterministic@1", "{}", 1,
  );
  db.prepare(`INSERT INTO online_review_inventory
    (run_id, reasons_json, sampling_policy_version, created_at) VALUES (?, ?, ?, ?)`).run(
    "run-1", JSON.stringify(["new-release"]), 1, 1,
  );
  return db;
}

describe("online review inventory synchronization", () => {
  it("queues exact observation evidence and durably retains the direct review reference", async () => {
    const db = setup();
    const transport = {
      ensureScoreConfig: vi.fn(async (config: { id: string }) => ({ id: config.id, contentHash: config.id })),
      ensureQueue: vi.fn(async () => ({ id: "queue-1" })),
      findQueueItem: vi.fn(async () => undefined),
      addQueueItem: vi.fn(async () => ({ id: "item-1" })),
      reviewReference: vi.fn(() => "https://langfuse.invalid/review/item-1"),
    };

    const result = await syncOnlineReviewInventory({ db, transport });

    expect(result.status).toBe("synced");
    expect(transport.addQueueItem).toHaveBeenCalledWith("queue-1", {
      objectId: "observation-1",
      objectType: "OBSERVATION",
    });
    expect(db.prepare(`SELECT observation_id, reasons_json, score_provenance, review_reference
      FROM online_review_queue_refs`).get()).toEqual({
      observation_id: "observation-1",
      reasons_json: JSON.stringify(["new-release"]),
      score_provenance: "online-deterministic@1",
      review_reference: "https://langfuse.invalid/review/item-1",
    });

    const repeated = await syncOnlineReviewInventory({ db, transport });
    expect(repeated).toEqual({ status: "synced", items: [] });
    expect(transport.addQueueItem).toHaveBeenCalledTimes(1);
  });

  it("fails closed before transport calls when authoritative evidence is unavailable", async () => {
    const db = setup();
    db.prepare("DELETE FROM agent_run_trace_refs").run();
    const transport = { ensureScoreConfig: vi.fn() };

    const result = await syncOnlineReviewInventory({ db, transport: transport as never });

    expect(result.status).toBe("unavailable");
    expect(transport.ensureScoreConfig).not.toHaveBeenCalled();
  });
});
