import type { LangfuseClient } from "@langfuse/client";
import { LangfuseAPIError } from "@langfuse/core";
import { describe, expect, it } from "vitest";
import { LangfuseClientTransport } from "./langfuseClientTransport";
import { LangfuseTransportError, type ScorePayload, type TracePayload } from "./langfuseExperimentSync";

function fakeClient(input: {
  getDataset?: (name: string, options: { abortSignal?: AbortSignal }) => Promise<unknown>;
  ingest?: (request: unknown, options: { abortSignal?: AbortSignal }) => Promise<unknown>;
} = {}) {
  const ingestions: unknown[] = [];
  const runItems: unknown[] = [];
  let sdkLifecycleCalls = 0;
  const client = {
    api: {
      datasets: {
        get: input.getDataset ?? (async (name: string) => ({ id: "dataset-id", name, metadata: {} })),
        create: async (payload: unknown) => payload,
        getRun: async () => ({
          id: "run-id",
          name: "run",
          metadata: {},
          datasetRunItems: [],
        }),
      },
      datasetItems: {
        get: async () => { throw new LangfuseAPIError({ statusCode: 404 }); },
        create: async (payload: unknown) => payload,
      },
      datasetRunItems: {
        create: async (payload: unknown) => {
          runItems.push(payload);
          return { id: "run-item-id", datasetRunId: "run-id", ...(payload as object) };
        },
      },
      trace: {
        get: async () => { throw new LangfuseAPIError({ statusCode: 404 }); },
      },
      ingestion: {
        batch: async (request: unknown, options: { abortSignal?: AbortSignal }) => {
          ingestions.push(request);
          return input.ingest?.(request, options) ?? { successes: [{ id: "event", status: 201 }], errors: [] };
        },
      },
      projects: { get: async () => ({ data: [{ id: "project-id" }] }) },
    },
    flush: async () => { sdkLifecycleCalls += 1; },
    shutdown: async () => { sdkLifecycleCalls += 1; },
  } as unknown as LangfuseClient;
  return { client, ingestions, runItems, sdkLifecycleCalls: () => sdkLifecycleCalls };
}

describe("LangfuseClientTransport", () => {
  it("maps traces, scores, run items, 404 reads, and comparison URLs onto SDK 5.9.1", async () => {
    const { client, ingestions, runItems, sdkLifecycleCalls } = fakeClient();
    const transport = new LangfuseClientTransport(client, "https://cloud.langfuse.com/");
    const trace: TracePayload = {
      id: "0123456789abcdef0123456789abcdef",
      name: "offline-evaluation",
      input: { prompt: "safe" },
      output: { outcome: "completed" },
      release: "0.2.1",
      version: "runner",
      environment: "evaluation",
      tags: ["release:0.2.1"],
      metadata: { sync: { schemaVersion: 1, contentHash: "hash" } },
    };
    const score: ScorePayload = {
      id: "abcdef0123456789abcdef0123456789",
      traceId: trace.id,
      name: "integrity.valid",
      value: 1,
      dataType: "NUMERIC",
    };

    expect(await transport.getDatasetItem("missing")).toBeUndefined();
    await transport.upsertTrace(trace);
    await transport.upsertScore(score);
    await transport.upsertDatasetRunItem({
      runName: "run",
      runDescription: "offline run",
      datasetItemId: "item-id",
      traceId: trace.id,
      metadata: { sync: { schemaVersion: 1, contentHash: "run-hash" } },
    });

    expect(ingestions).toEqual([
      { batch: [expect.objectContaining({ type: "trace-create", body: trace })] },
      { batch: [expect.objectContaining({ type: "score-create", body: expect.objectContaining(score) })] },
    ]);
    expect(runItems).toEqual([expect.objectContaining({ runName: "run", datasetItemId: "item-id" })]);
    await expect(transport.comparisonUrls("dataset-id", "run-id")).resolves.toEqual({
      dataset: "https://cloud.langfuse.com/project/project-id/datasets/dataset-id",
      cohort: "https://cloud.langfuse.com/project/project-id/datasets/dataset-id/runs/run-id",
    });
    await transport.flush();
    await transport.shutdown();
    expect(sdkLifecycleCalls()).toBe(0);
  });

  it("classifies SDK and multi-status ingestion failures without leaking SDK messages", async () => {
    const unavailable = fakeClient({
      getDataset: async () => {
        throw new LangfuseAPIError({ message: "secret-bearing upstream text", statusCode: 503 });
      },
    });
    const transport = new LangfuseClientTransport(unavailable.client, "https://cloud.langfuse.com");

    await expect(transport.getDataset("dataset")).rejects.toMatchObject({
      name: "LangfuseTransportError",
      message: "Langfuse request failed (HTTP 503)",
      retryable: true,
    });

    const rejected = fakeClient({
      ingest: async () => ({ successes: [], errors: [{ id: "event", status: 400, message: "bad input" }] }),
    });
    const rejectedTransport = new LangfuseClientTransport(rejected.client, "https://cloud.langfuse.com");
    await expect(rejectedTransport.upsertScore({
      id: "score",
      traceId: "trace",
      name: "integrity.valid",
      value: 1,
      dataType: "NUMERIC",
    })).rejects.toEqual(expect.objectContaining<Partial<LangfuseTransportError>>({ retryable: false }));
  });

  it("forwards abort signals to SDK requests so timed-out network work is cancelled", async () => {
    let forwarded: AbortSignal | undefined;
    const pending = fakeClient({
      getDataset: async (_name, options) => {
        forwarded = options.abortSignal;
        return new Promise((_resolve, reject) => {
          forwarded?.addEventListener("abort", () => reject(forwarded?.reason), { once: true });
        });
      },
    });
    const transport = new LangfuseClientTransport(pending.client, "https://cloud.langfuse.com");
    const controller = new AbortController();
    const request = transport.getDataset("dataset", controller.signal);

    controller.abort(new Error("deadline"));

    await expect(request).rejects.toMatchObject({ name: "LangfuseTransportError", retryable: true });
    expect(forwarded).toBe(controller.signal);
    expect(forwarded?.aborted).toBe(true);
  });
});
