import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { LangfuseSyncTransport, OfflineExperimentCohort } from "./langfuseExperimentSync";
import { runOfflineExperimentSyncCommand } from "./syncOfflineExperimentCommand";

it("persists direct comparison references in a local sync report", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chamfer-langfuse-sync-"));
  const cohortPath = join(directory, "cohort.json");
  const reportPath = join(directory, "langfuse-sync.json");
  const cohort: OfflineExperimentCohort = {
    datasetName: "chamfer-command-test",
    cohortId: "command-cohort",
    release: "0.2.1",
    evaluationMode: "scripted-infrastructure",
    modality: "text",
    complexity: "smoke",
    category: "construction",
    purpose: "sync-command-test",
    gating: "non-gating",
    identities: {
      corpus: "corpus",
      agentConfiguration: "agent",
      commit: "commit",
      model: "model",
      evaluator: "evaluator",
      rubric: "rubric",
      runner: "runner",
      repetition: "repetition",
    },
    cases: [{
      caseId: "case",
      caseVersion: "1",
      repetition: { index: 1, hash: "sha256:repetition-1" },
      input: { prompt: "Create a safe test square." },
      expectedOutput: { outcome: "completed" },
      output: { outcome: "completed" },
      taskOutcome: "completed",
      measurements: {
        integrity: [],
        proficiency: [],
        reliability: [],
        efficiency: [],
        diagnostic: [],
      },
    }],
  };
  await writeFile(cohortPath, JSON.stringify(cohort));
  const transport: LangfuseSyncTransport = {
    async getDataset() { return undefined; },
    async upsertDataset(payload) { return { id: "dataset-id", name: payload.name, metadata: payload.metadata }; },
    async getDatasetItem() { return undefined; },
    async upsertDatasetItem(payload) { return { id: payload.id, datasetId: "dataset-id", metadata: payload.metadata }; },
    async getDatasetRun() { return undefined; },
    async getTrace() { return undefined; },
    async upsertTrace() {},
    async upsertDatasetRunItem(payload) {
      return { id: "item-id", datasetRunId: "run-id", datasetItemId: payload.datasetItemId, traceId: payload.traceId };
    },
    async upsertScore() {},
    async comparisonUrls() {
      return { dataset: "https://example.test/dataset", cohort: "https://example.test/cohort" };
    },
    async flush() {},
    async shutdown() {},
  };

  const report = await runOfflineExperimentSyncCommand({ cohortPath, reportPath, transport });

  expect(report).toMatchObject({
    schemaVersion: 1,
    cohortId: "command-cohort",
    localAuthority: true,
    result: {
      status: "synced",
      references: {
        dataset: "https://example.test/dataset",
        cohort: "https://example.test/cohort",
      },
    },
  });
  expect(JSON.parse(await readFile(reportPath, "utf8"))).toEqual(report);
});
