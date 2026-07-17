import type { DatabaseSync } from "node:sqlite";
import {
  semanticReviewScoreConfigs,
  syncReviewQueue,
  type ReviewQueueSyncResult,
  type ReviewQueueTransport,
} from "./reviewQueue";

interface InventoryRow {
  run_id: string;
  reasons_json: string;
  observation_id: string | null;
  score_provenance: string | null;
}

/** Synchronizes the bounded local online inventory and durably retains exact human-review references. */
export async function syncOnlineReviewInventory(input: {
  db: DatabaseSync;
  transport: ReviewQueueTransport;
  queueName?: string;
  limit?: number;
}): Promise<ReviewQueueSyncResult> {
  const limit = Math.max(1, Math.min(input.limit ?? 100, 500));
  const rows = input.db.prepare(`SELECT inventory.run_id, inventory.reasons_json,
      refs.observation_id, scores.score_provenance
    FROM online_review_inventory inventory
    LEFT JOIN agent_run_trace_refs refs ON refs.run_id = inventory.run_id
    LEFT JOIN online_run_scores scores ON scores.run_id = inventory.run_id
    LEFT JOIN online_review_queue_refs queued ON queued.run_id = inventory.run_id
    WHERE queued.run_id IS NULL
    ORDER BY inventory.created_at ASC, inventory.run_id ASC
    LIMIT ?`).all(limit) as unknown as InventoryRow[];
  const candidates = rows.map((row) => ({
    evidenceId: row.run_id,
    objectId: row.observation_id ?? "unavailable",
    objectType: "OBSERVATION" as const,
    selectionReasons: JSON.parse(row.reasons_json) as string[],
    scoreProvenance: row.score_provenance ?? "unavailable",
    evidenceSufficient: Boolean(row.observation_id && row.score_provenance),
  }));
  if (candidates.length === 0) return { status: "synced", items: [] };
  const result = await syncReviewQueue({
    queueName: input.queueName ?? "chamfer-semantic-review-v1",
    configs: semanticReviewScoreConfigs,
    candidates,
    transport: input.transport,
  });
  if (result.status !== "synced" || !result.queueId) return result;
  const byRun = new Map(rows.map((row) => [row.run_id, row]));
  input.db.exec("BEGIN IMMEDIATE");
  try {
    for (const item of result.items) {
      const row = byRun.get(item.evidenceId);
      if (!row?.observation_id || !row.score_provenance) continue;
      input.db.prepare(`INSERT OR IGNORE INTO online_review_queue_refs
        (run_id, queue_id, queue_item_id, observation_id, reasons_json,
         score_provenance, review_reference, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        row.run_id,
        result.queueId,
        item.queueItemId,
        row.observation_id,
        JSON.stringify(item.selectionReasons),
        row.score_provenance,
        item.reference,
        Date.now(),
      );
    }
    input.db.exec("COMMIT");
  } catch (error) {
    input.db.exec("ROLLBACK");
    return { status: "unavailable", reason: error instanceof Error ? error.message : String(error), items: [] };
  }
  return result;
}
