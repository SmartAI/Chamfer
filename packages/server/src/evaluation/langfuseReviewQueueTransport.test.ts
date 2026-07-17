import { describe, expect, it, vi } from "vitest";
import { semanticReviewScoreConfigs, syncReviewQueue } from "./reviewQueue";
import { LangfuseRestReviewQueueTransport } from "./langfuseReviewQueueTransport";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function page(data: unknown[]) {
  return { data, meta: { page: 1, limit: 100, totalItems: data.length, totalPages: 1 } };
}

describe("Langfuse REST review queue transport", () => {
  it("creates score configs before a compatible queue and returns a direct item reference", async () => {
    const config = semanticReviewScoreConfigs[0];
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes("/score-configs?") && init?.method !== "POST") return json(page([]));
      if (url.endsWith("/score-configs") && init?.method === "POST") {
        return json({ ...config, id: "config-1", isArchived: false });
      }
      if (url.includes("/annotation-queues?") && !url.includes("/items")) return json(page([]));
      if (url.endsWith("/annotation-queues") && init?.method === "POST") {
        return json({ id: "queue-1", name: "review-v1", scoreConfigIds: ["config-1"] });
      }
      if (url.endsWith("/api/public/projects")) return json({ data: [{ id: "project-1" }] });
      if (url.includes("/annotation-queues/queue-1/items?") && init?.method !== "POST") return json(page([]));
      if (url.endsWith("/annotation-queues/queue-1/items") && init?.method === "POST") {
        return json({ id: "item-1", objectId: "observation-1" });
      }
      return json({}, 404);
    }) as typeof fetch;
    const transport = new LangfuseRestReviewQueueTransport({
      baseUrl: "https://langfuse.invalid",
      publicKey: "public",
      secretKey: "secret",
      fetchImpl,
    });

    const result = await syncReviewQueue({
      queueName: "review-v1",
      configs: [config],
      candidates: [{
        evidenceId: "evidence-1",
        objectId: "observation-1",
        objectType: "OBSERVATION",
        selectionReasons: ["new-release"],
        scoreProvenance: "online-deterministic@1",
        evidenceSufficient: true,
      }],
      transport,
    });

    expect(result).toMatchObject({
      status: "synced",
      queueId: "queue-1",
      items: [{
        queueItemId: "item-1",
        reference: "https://langfuse.invalid/project/project-1/annotation-queues/queue-1/items/item-1",
      }],
    });
    expect(calls.findIndex(({ url, init }) => url.endsWith("/score-configs") && init?.method === "POST"))
      .toBeLessThan(calls.findIndex(({ url, init }) => url.endsWith("/annotation-queues") && init?.method === "POST"));
    const authorization = new Headers(calls[0]?.init?.headers).get("authorization");
    expect(authorization).toBe(`Basic ${Buffer.from("public:secret").toString("base64")}`);
  });

  it("fails closed when a versioned config name has an incompatible schema", async () => {
    const config = semanticReviewScoreConfigs[0];
    const fetchImpl = vi.fn(async () => json(page([{
      ...config,
      id: "config-1",
      categories: [{ label: "different", value: 0 }],
      isArchived: false,
    }]))) as typeof fetch;
    const transport = new LangfuseRestReviewQueueTransport({
      baseUrl: "https://langfuse.invalid",
      publicKey: "public",
      secretKey: "secret",
      fetchImpl,
    });

    await expect(transport.ensureScoreConfig(config)).rejects.toThrow("incompatible schema");
  });

  it("retries a rate-limited request before using compatible hosted state", async () => {
    const config = semanticReviewScoreConfigs[0];
    let attempts = 0;
    const fetchImpl = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response("rate limited", { status: 429, headers: { "retry-after": "0" } });
      }
      return json(page([{ ...config, id: "config-1", isArchived: false }]));
    }) as typeof fetch;
    const transport = new LangfuseRestReviewQueueTransport({
      baseUrl: "https://langfuse.invalid",
      publicKey: "public",
      secretKey: "secret",
      fetchImpl,
      retryDelayMs: 0,
    });

    await expect(transport.ensureScoreConfig(config)).resolves.toEqual({
      id: "config-1",
      contentHash: expect.any(String),
    });
    expect(attempts).toBe(2);
  });

  it("loads one queue inventory for repeated duplicate checks", async () => {
    const fetchImpl = vi.fn(async () => json(page([
      { id: "item-1", objectId: "trace-1" },
      { id: "item-2", objectId: "trace-2" },
    ]))) as typeof fetch;
    const transport = new LangfuseRestReviewQueueTransport({
      baseUrl: "https://langfuse.invalid",
      publicKey: "public",
      secretKey: "secret",
      fetchImpl,
    });

    await expect(transport.findQueueItem("queue-1", "trace-1")).resolves.toEqual({
      id: "item-1",
      objectId: "trace-1",
    });
    await expect(transport.findQueueItem("queue-1", "trace-2")).resolves.toEqual({
      id: "item-2",
      objectId: "trace-2",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
