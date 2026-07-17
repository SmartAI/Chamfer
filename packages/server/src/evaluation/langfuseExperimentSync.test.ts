import { describe, expect, it } from "vitest";
import {
  LangfuseSyncConflictError,
  LangfuseTransportError,
  syncOfflineExperiment,
  type DatasetItemPayload,
  type LangfuseSyncTransport,
  type OfflineExperimentCohort,
  type ScorePayload,
  type TracePayload,
} from "./langfuseExperimentSync";

function cohort(): OfflineExperimentCohort {
  return {
    datasetName: "chamfer-canonical-v1",
    cohortId: "cohort-release-0.2.1-text",
    release: "0.2.1",
    evaluationMode: "scripted-infrastructure",
    modality: "text",
    complexity: "precise",
    category: "construction",
    purpose: "release-gate",
    gating: "required",
    identities: {
      corpus: "corpus-sha256",
      agentConfiguration: "agent-config-sha256",
      commit: "commit-sha",
      model: "scripted-model-v1",
      evaluator: "evaluator-sha256",
      rubric: "rubric-sha256",
      runner: "runner-sha256",
      repetition: "repetition-1",
      parentCohort: "parent-cohort-id",
    },
    cases: [
      {
        caseId: "text.precise.bracket",
        caseVersion: "1.0.0",
        repetition: { index: 1, hash: "sha256:repetition-1" },
        input: { prompt: "Create a 20 mm square bracket." },
        expectedOutput: { outcome: "completed", widthMm: 20 },
        output: { outcome: "completed", widthMm: 20.01 },
        taskOutcome: "completed",
        measurements: {
          integrity: [{ name: "evidence_valid", value: 1 }],
          proficiency: [{ name: "dimensional_accuracy", value: 0.99 }],
          reliability: [{ name: "completed", value: 1 }],
          efficiency: [{ name: "cad_runs", value: 1 }],
          diagnostic: [{ name: "retries", value: 0 }],
        },
      },
    ],
  };
}

function recordingTransport() {
  const calls: { operation: string; payload?: unknown }[] = [];
  let dataset: Awaited<ReturnType<LangfuseSyncTransport["upsertDataset"]>> | undefined;
  const items = new Map<string, Awaited<ReturnType<LangfuseSyncTransport["upsertDatasetItem"]>>>();
  const traces = new Map<string, { id: string; metadata?: unknown }>();
  let run: Awaited<ReturnType<LangfuseSyncTransport["getDatasetRun"]>>;
  const transport: LangfuseSyncTransport = {
    async getDataset() {
      return dataset;
    },
    async upsertDataset(payload) {
      calls.push({ operation: "dataset", payload });
      dataset = { id: "dataset-remote-id", name: payload.name, metadata: payload.metadata };
      return dataset;
    },
    async getDatasetItem(id) {
      return items.get(id);
    },
    async upsertDatasetItem(payload) {
      calls.push({ operation: "item", payload });
      const item = { id: payload.id, datasetId: "dataset-remote-id", metadata: payload.metadata };
      items.set(payload.id, item);
      return item;
    },
    async getDatasetRun() {
      return run;
    },
    async getTrace(id) {
      return traces.get(id);
    },
    async upsertTrace(payload) {
      calls.push({ operation: "trace", payload });
      traces.set(payload.id, { id: payload.id, metadata: payload.metadata });
    },
    async upsertDatasetRunItem(payload) {
      calls.push({ operation: "run-item", payload });
      run ??= { id: "run-remote-id", name: payload.runName, metadata: payload.metadata, items: [] };
      if (!run.items.some(({ datasetItemId }) => datasetItemId === payload.datasetItemId)) {
        run.items.push({ datasetItemId: payload.datasetItemId, traceId: payload.traceId });
      }
      return { id: "run-item-id", datasetRunId: run.id, datasetItemId: payload.datasetItemId, traceId: payload.traceId };
    },
    async upsertScore(payload) {
      calls.push({ operation: "score", payload });
    },
    async comparisonUrls(datasetId, datasetRunId) {
      return {
        dataset: `https://cloud.langfuse.com/project/project-id/datasets/${datasetId}`,
        cohort: `https://cloud.langfuse.com/project/project-id/datasets/${datasetId}/runs/${datasetRunId}`,
      };
    },
    async flush() {
      calls.push({ operation: "flush" });
    },
    async shutdown() {
      calls.push({ operation: "shutdown" });
    },
  };
  return { calls, transport };
}

describe("syncOfflineExperiment", () => {
  it("maps one local-authoritative cohort into a comparable dataset run with measurements as scores", async () => {
    const { calls, transport } = recordingTransport();

    const result = await syncOfflineExperiment(cohort(), { transport, retryDelayMs: 0 });

    expect(result).toEqual({
      status: "synced",
      datasetId: "dataset-remote-id",
      datasetRunId: "run-remote-id",
      references: {
        dataset: "https://cloud.langfuse.com/project/project-id/datasets/dataset-remote-id",
        cohort: "https://cloud.langfuse.com/project/project-id/datasets/dataset-remote-id/runs/run-remote-id",
      },
    });
    expect(calls.map(({ operation }) => operation)).toEqual([
      "dataset",
      "item",
      "trace",
      "score",
      "score",
      "score",
      "score",
      "score",
      "score",
      "run-item",
      "flush",
      "shutdown",
    ]);
    expect(calls.find(({ operation }) => operation === "run-item")?.payload).toMatchObject({
      runName: expect.stringMatching(/^chamfer-cohort-/),
      metadata: {
        release: "0.2.1",
        evaluationMode: "scripted-infrastructure",
        modality: "text",
        complexity: "precise",
        category: "construction",
        purpose: "release-gate",
        gating: "required",
        tags: [
          "release:0.2.1",
          "evaluation-mode:scripted-infrastructure",
          "modality:text",
          "complexity:precise",
          "category:construction",
          "purpose:release-gate",
          "gating:required",
        ],
        identities: cohort().identities,
      },
    });
    expect(calls.find(({ operation }) => operation === "item")?.payload).toMatchObject({
      id: expect.stringMatching(/^chamfer-case-[a-f0-9]{64}$/),
      metadata: {
        caseId: "text.precise.bracket",
        caseVersion: "1.0.0",
        corpusId: "corpus-sha256",
      },
    });
    expect(calls.find(({ operation }) => operation === "trace")?.payload).toMatchObject({
      metadata: {
        case: { id: "text.precise.bracket", version: "1.0.0" },
        identities: cohort().identities,
      },
    });
    expect(calls.filter(({ operation }) => operation === "score").map(({ payload }) => payload)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "task_outcome", value: "completed", dataType: "CATEGORICAL" }),
        expect.objectContaining({ name: "integrity.evidence_valid", value: 1, dataType: "NUMERIC" }),
        expect.objectContaining({ name: "proficiency.dimensional_accuracy", value: 0.99 }),
        expect.objectContaining({ name: "reliability.completed", value: 1 }),
        expect.objectContaining({ name: "efficiency.cad_runs", value: 1 }),
        expect.objectContaining({ name: "diagnostic.retries", value: 0 }),
      ]),
    );
  });

  it("preserves repeated attempts as distinct hosted records with repetition metadata", async () => {
    const repeated = cohort();
    const first = Object.assign(repeated.cases[0]!, {
      repetition: { index: 1, hash: "sha256:repetition-1" },
    });
    const second = Object.assign(structuredClone(first), {
      repetition: { index: 2, hash: "sha256:repetition-2" },
    });
    repeated.cases = [first, second];
    const { calls, transport } = recordingTransport();

    await syncOfflineExperiment(repeated, { transport, retryDelayMs: 0 });

    const itemPayloads = calls.filter(({ operation }) => operation === "item").map(({ payload }) => payload as DatasetItemPayload);
    const tracePayloads = calls.filter(({ operation }) => operation === "trace").map(({ payload }) => payload as TracePayload);
    const scorePayloads = calls.filter(({ operation }) => operation === "score").map(({ payload }) => payload as ScorePayload);
    expect(new Set(itemPayloads.map(({ id }) => id)).size).toBe(2);
    expect(new Set(tracePayloads.map(({ id }) => id)).size).toBe(2);
    expect(new Set(scorePayloads.map(({ id }) => id)).size).toBe(scorePayloads.length);
    expect(itemPayloads.map(({ metadata }) => metadata.repetition)).toEqual([
      { index: 1, hash: "sha256:repetition-1" },
      { index: 2, hash: "sha256:repetition-2" },
    ]);
    expect(calls.filter(({ operation }) => operation === "run-item")).toHaveLength(2);
  });

  it("replays an already synchronized cohort without rewriting hosted content", async () => {
    const { calls, transport } = recordingTransport();
    await syncOfflineExperiment(cohort(), { transport, retryDelayMs: 0 });
    calls.length = 0;

    const result = await syncOfflineExperiment(cohort(), { transport, retryDelayMs: 0 });

    expect(result.status).toBe("synced");
    expect(calls.map(({ operation }) => operation)).toEqual(["flush", "shutdown"]);
  });

  it("rejects a reused stable case identity when its canonical content changes", async () => {
    const { calls, transport } = recordingTransport();
    await syncOfflineExperiment(cohort(), { transport, retryDelayMs: 0 });
    calls.length = 0;
    const changed = cohort();
    changed.cases[0]!.input = { prompt: "Create a different object under the same identity." };

    await expect(syncOfflineExperiment(changed, { transport, retryDelayMs: 0 })).rejects.toBeInstanceOf(
      LangfuseSyncConflictError,
    );
    expect(calls.map(({ operation }) => operation)).toEqual(["flush", "shutdown"]);
  });

  it("rejects a project-global case identity already owned by another dataset", async () => {
    const { calls, transport } = recordingTransport();
    await syncOfflineExperiment(cohort(), { transport, retryDelayMs: 0 });
    calls.length = 0;
    transport.getDataset = async () => undefined;

    await expect(syncOfflineExperiment(cohort(), { transport, retryDelayMs: 0 })).rejects.toThrow(
      /belongs to another hosted dataset/,
    );
    expect(calls.map(({ operation }) => operation)).toEqual(["flush", "shutdown"]);
  });

  it("revalidates dataset identity after a concurrent create conflict", async () => {
    const { transport } = recordingTransport();
    transport.upsertDataset = async (payload) => ({
      id: "raced-dataset",
      name: payload.name,
      metadata: { sync: { schemaVersion: 1, contentHash: "different" } },
    });

    await expect(syncOfflineExperiment(cohort(), { transport, retryDelayMs: 0 })).rejects.toBeInstanceOf(
      LangfuseSyncConflictError,
    );
  });

  it("retries a transient Langfuse failure before synchronizing", async () => {
    const { transport } = recordingTransport();
    const getDataset = transport.getDataset.bind(transport);
    let attempts = 0;
    transport.getDataset = async (name) => {
      attempts += 1;
      if (attempts < 3) throw new LangfuseTransportError("temporary outage", true);
      return getDataset(name);
    };

    const result = await syncOfflineExperiment(cohort(), { transport, retryDelayMs: 0 });

    expect(result.status).toBe("synced");
    expect(attempts).toBe(3);
  });

  it("skips synchronization when credentials did not create a transport", async () => {
    await expect(syncOfflineExperiment(cohort(), {})).resolves.toEqual({
      status: "skipped",
      reason: "missing_credentials",
    });
  });

  it("reports an outage without replacing or weakening the completed local result", async () => {
    const { calls, transport } = recordingTransport();
    let attempts = 0;
    transport.getDataset = async () => {
      attempts += 1;
      throw new LangfuseTransportError("host unreachable", true);
    };

    const result = await syncOfflineExperiment(cohort(), { transport, retryDelayMs: 0 });

    expect(result).toEqual({ status: "unavailable", reason: "host unreachable" });
    expect(attempts).toBe(3);
    expect(calls.map(({ operation }) => operation)).toEqual(["flush", "shutdown"]);
  });

  it("bounds unreachable operations, flush, and shutdown so synchronization cannot hang completion", async () => {
    const { transport } = recordingTransport();
    const never = () => new Promise<never>(() => {});
    let operationAborted = false;
    transport.getDataset = async (_name, signal) => new Promise<never>((_resolve, reject) => {
      signal?.addEventListener("abort", () => {
        operationAborted = true;
        reject(signal.reason);
      }, { once: true });
    });
    transport.flush = never;
    transport.shutdown = never;

    const result = await Promise.race([
      syncOfflineExperiment(cohort(), {
        transport,
        maxAttempts: 1,
        operationTimeoutMs: 10,
        shutdownTimeoutMs: 10,
      }),
      new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 100)),
    ]);

    expect(result).toEqual({ status: "unavailable", reason: "get dataset timed out" });
    expect(operationAborted).toBe(true);
  });
});
