import { expect, it } from "vitest";
import { createLangfuseSyncTransportFromEnv } from "./langfuseClientTransport";
import { syncOfflineExperiment, type OfflineExperimentCohort } from "./langfuseExperimentSync";

const smokeEnabled = process.env.CHAMFER_LANGFUSE_SMOKE === "1"
  && Boolean(process.env.LANGFUSE_PUBLIC_KEY)
  && Boolean(process.env.LANGFUSE_SECRET_KEY);

it.runIf(smokeEnabled)("synchronizes one privacy-safe tracer case into the configured Langfuse project", async () => {
  const transport = createLangfuseSyncTransportFromEnv();
  expect(transport).toBeDefined();

  const cohort: OfflineExperimentCohort = {
    datasetName: "chamfer-agent-evaluation-smoke-v1",
    cohortId: "langfuse-sync-smoke-v1",
    release: "smoke",
    evaluationMode: "scripted-infrastructure",
    modality: "text",
    complexity: "precise",
    category: "construction",
    purpose: "integration-smoke",
    gating: "non-gating",
    identities: {
      corpus: "smoke-corpus-v1",
      agentConfiguration: { name: "current", identityHash: "a".repeat(64) },
      commit: "smoke",
      model: "scripted-smoke-model-v1",
      evaluator: "smoke-evaluator-v1",
      rubric: "smoke-rubric-v1",
      runner: "smoke-runner-v1",
      repetition: "smoke-repetition-1",
    },
    cases: [{
      caseId: "smoke.text.precise.square",
      caseVersion: "1.0.0",
      repetition: { index: 1, hash: "sha256:smoke-repetition-1" },
      input: { prompt: "Create a 10 mm square test plate." },
      expectedOutput: { outcome: "completed", widthMm: 10 },
      output: { outcome: "completed", widthMm: 10 },
      taskOutcome: "completed",
      measurements: {
        integrity: [{ name: "evidence_valid", value: 1 }],
        proficiency: [{ name: "dimensional_accuracy", value: 1 }],
        reliability: [{ name: "completed", value: 1 }],
        efficiency: [{ name: "cad_runs", value: 1 }],
        diagnostic: [],
      },
    }],
  };

  const result = await syncOfflineExperiment(cohort, { transport });

  expect(result.status).toBe("synced");
  if (result.status === "synced") expect(result.references.cohort).toContain("/datasets/");
});
