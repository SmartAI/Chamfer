import { describe, expect, it, vi } from "vitest";
import { syncOfflineReviewCohort } from "./offlineReviewQueueSync";
import type { OfflineExperimentCohort } from "./langfuseExperimentSync";

it("queues synchronized offline trace identities with canonical score provenance", async () => {
  const transport = {
    ensureScoreConfig: vi.fn(async (config: { id: string }) => ({ id: config.id, contentHash: config.id })),
    ensureQueue: vi.fn(async () => ({ id: "queue-1" })),
    findQueueItem: vi.fn(async () => undefined),
    addQueueItem: vi.fn(async () => ({ id: "item-1" })),
    reviewReference: vi.fn(() => "https://langfuse.invalid/review/item-1"),
  };
  const cohort = {
    datasetName: "chamfer",
    cohortId: "cohort-1",
    release: "0.2.2",
    evaluationMode: "release",
    modality: "image",
    complexity: "standard",
    category: "image",
    purpose: "fixture",
    gating: "release",
    identities: {
      corpus: "corpus",
      agentConfiguration: { name: "current", identityHash: "a".repeat(64) },
      commit: "commit",
      model: "model",
      evaluator: "evaluator-v1",
      rubric: "rubric-v1",
      runner: "runner-v1",
      repetition: "repetition",
    },
    cases: [{
      caseId: "image.case",
      caseVersion: "1",
      repetition: { index: 1, hash: "sha256:repetition-1" },
      input: { prompt: "synthetic" },
      output: { outcome: "completed" },
      taskOutcome: "completed",
      measurements: { integrity: [], proficiency: [], reliability: [], efficiency: [], diagnostic: [] },
    }],
  } satisfies OfflineExperimentCohort;

  const result = await syncOfflineReviewCohort({ cohort, transport });

  expect(result.status).toBe("synced");
  expect(transport.addQueueItem).toHaveBeenCalledWith("queue-1", {
    objectId: expect.stringMatching(/^[a-f0-9]{32}$/),
    objectType: "TRACE",
  });
  expect(result.items[0]).toMatchObject({
    evidenceId: "image.case@1#1",
    scoreProvenance: "offline-canonical@evaluator-v1",
  });
});
