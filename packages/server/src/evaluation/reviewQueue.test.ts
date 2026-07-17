import { describe, expect, it, vi } from "vitest";
import { semanticReviewScoreConfigs, syncReviewQueue } from "./reviewQueue";

function candidate(id = "evidence-1") {
  return {
    evidenceId: id,
    objectId: `observation-${id}`,
    objectType: "OBSERVATION" as const,
    selectionReasons: ["suspected-false-success"],
    scoreProvenance: "online-deterministic@1",
    evidenceSufficient: true,
  };
}

describe("Langfuse review queue synchronization", () => {
  it("creates compatible score configurations before the queue and deduplicates items", async () => {
    const calls: string[] = [];
    const existingItems = new Set<string>();
    const transport = {
      ensureScoreConfig: vi.fn(async (config: { id: string }) => {
        calls.push(`config:${config.id}`);
        return { id: config.id, contentHash: `hash:${config.id}` };
      }),
      ensureQueue: vi.fn(async (_name: string, configIds: string[]) => {
        calls.push(`queue:${configIds.length}`);
        return { id: "queue-1" };
      }),
      findQueueItem: vi.fn(async (_queueId: string, objectId: string) =>
        existingItems.has(objectId) ? { id: `existing-${objectId}` } : undefined),
      addQueueItem: vi.fn(async (_queueId: string, item: { objectId: string }) => {
        existingItems.add(item.objectId);
        return { id: `item-${item.objectId}` };
      }),
      reviewReference: vi.fn((_queueId: string, itemId: string) => `https://review.invalid/${itemId}`),
    };
    const first = await syncReviewQueue({
      queueName: "chamfer-semantic-review-v1",
      configs: semanticReviewScoreConfigs,
      candidates: [candidate()],
      transport,
    });
    expect(first.status).toBe("synced");
    expect(calls.at(-1)).toBe(`queue:${semanticReviewScoreConfigs.length}`);
    expect(first.items[0]?.reference).toContain("item-observation-evidence-1");

    const second = await syncReviewQueue({
      queueName: "chamfer-semantic-review-v1",
      configs: semanticReviewScoreConfigs,
      candidates: [candidate()],
      transport,
    });
    expect(second.items[0]?.duplicate).toBe(true);
    expect(transport.addQueueItem).toHaveBeenCalledTimes(1);
  });

  it("rejects candidates without authoritative provenance or sufficient evidence", async () => {
    const result = await syncReviewQueue({
      queueName: "review",
      configs: semanticReviewScoreConfigs,
      candidates: [{ ...candidate(), evidenceSufficient: false }],
      transport: {} as never,
    });
    expect(result.status).toBe("unavailable");
    expect(result.items).toEqual([]);
  });

  it("isolates queue outages", async () => {
    const result = await syncReviewQueue({
      queueName: "review",
      configs: semanticReviewScoreConfigs,
      candidates: [candidate()],
      transport: {
        ensureScoreConfig: vi.fn().mockRejectedValue(new Error("offline")),
      } as never,
    });
    expect(result).toMatchObject({ status: "unavailable", reason: "offline", items: [] });
  });
});
