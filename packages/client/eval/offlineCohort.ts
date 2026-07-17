import { canonicalJson, sha256Identity } from "./identity";
import type { EvaluationResult } from "./result";
import type { EvaluationCase } from "./schema";

type Measurement = {
  name: string;
  value: number | string;
  dataType?: "NUMERIC" | "CATEGORICAL" | "BOOLEAN" | "TEXT";
  comment?: string;
};

export interface OfflineExperimentCohortProjection {
  datasetName: string;
  cohortId: string;
  release: string;
  evaluationMode: string;
  modality: string;
  complexity: string;
  category: string;
  purpose: string;
  gating: string;
  identities: {
    corpus: string;
    agentConfiguration: string;
    commit: string;
    model: string;
    evaluator: string;
    rubric: string;
    runner: string;
    repetition: string;
  };
  cases: Array<{
    caseId: string;
    caseVersion: string;
    repetition: { index: number; hash: string };
    input: unknown;
    expectedOutput: unknown;
    output: unknown;
    taskOutcome: string;
    measurements: {
      integrity: Measurement[];
      proficiency: Measurement[];
      reliability: Measurement[];
      efficiency: Measurement[];
      diagnostic: Measurement[];
    };
  }>;
}

function common(values: string[]): string {
  const distinct = [...new Set(values)].sort();
  return distinct.length === 1 ? distinct[0]! : "mixed";
}

function numberMeasurement(name: string, value: number): Measurement {
  return { name, value, dataType: "NUMERIC" };
}

function measurements(result: EvaluationResult): OfflineExperimentCohortProjection["cases"][number]["measurements"] {
  const integrityPass = result.integrity.violations.length === 0 &&
    !(result.outcome.kind === "completed" && result.scores.some((score) => score.required && score.status !== "passed"));
  return {
    integrity: [{ name: "integrity-pass", value: integrityPass ? 1 : 0, dataType: "BOOLEAN" }],
    proficiency: [
      { name: "expected-outcome-match", value: result.outcome.expectedMatch ? 1 : 0, dataType: "BOOLEAN" },
      ...result.scores.map((score) => ({
        name: `evaluator-${score.id}`,
        value: score.status === "passed" ? 1 : score.status === "failed" ? 0 : "unavailable",
        dataType: score.status === "unavailable" ? "CATEGORICAL" as const : "BOOLEAN" as const,
        ...(score.explanation ? { comment: score.explanation } : {}),
      })),
    ],
    reliability: [
      { name: "execution-state", value: result.execution.state, dataType: "CATEGORICAL" },
      { name: "task-outcome", value: result.outcome.kind, dataType: "CATEGORICAL" },
    ],
    efficiency: [
      numberMeasurement("provider-cost", result.measurements.providerCost),
      numberMeasurement("wall-time-ms", result.execution.durationMs),
      numberMeasurement("input-tokens", result.measurements.inputTokens),
      numberMeasurement("output-tokens", result.measurements.outputTokens),
      numberMeasurement("model-calls", result.measurements.modelCalls),
      numberMeasurement("tool-calls", result.measurements.toolCalls),
      numberMeasurement("cad-runs", result.measurements.cadRuns),
    ],
    diagnostic: [
      numberMeasurement("tool-errors", result.measurements.toolErrors),
      numberMeasurement("retries", result.measurements.retries ?? 0),
      numberMeasurement("compactions", result.measurements.compactions ?? 0),
      numberMeasurement("persistence-failures", result.measurements.persistenceFailures ?? 0),
    ],
  };
}

export function buildOfflineExperimentCohort(input: {
  results: EvaluationResult[];
  cases: EvaluationCase[];
}): OfflineExperimentCohortProjection {
  if (input.results.length === 0) throw new Error("Cannot project an empty offline cohort");
  const first = input.results[0]!;
  for (const result of input.results) {
    if (result.identities.corpus.hash !== first.identities.corpus.hash ||
        result.identities.agentConfiguration.hash !== first.identities.agentConfiguration.hash ||
        canonicalJson(result.identities.runner) !== canonicalJson(first.identities.runner)) {
      throw new Error("Offline synchronization requires one compatible corpus, agent configuration, and runner");
    }
  }
  const caseMap = new Map(input.cases.map((evaluationCase) => [
    `${evaluationCase.id}@${evaluationCase.version}`,
    evaluationCase,
  ]));
  const evaluatorIdentity = sha256Identity(first.identities.evaluators);
  const rubricIdentity = sha256Identity(first.identities.rubrics);
  const repetitions = [...new Set(input.results.map((result) => result.identities.repetition.index))]
    .sort((left, right) => left - right)
    .join(",");
  const cohortId = sha256Identity({
    corpus: first.identities.corpus,
    agentConfiguration: first.identities.agentConfiguration,
    runner: first.identities.runner,
    attempts: input.results.map((result) => ({
      case: result.identities.case,
      repetition: result.identities.repetition,
    })),
  });
  return {
    datasetName: `chamfer-${first.identities.corpus.id}-v${first.identities.corpus.version}`,
    cohortId,
    release: first.identities.agentConfiguration.productRelease,
    evaluationMode: common(input.results.map((result) => result.evidenceClass)),
    modality: common(input.results.map((result) => result.identities.case.modality)),
    complexity: common(input.results.map((result) => result.identities.case.complexity)),
    category: common(input.results.flatMap((result) => result.identities.case.categories)),
    purpose: common(input.results.map((result) => result.identities.case.purpose)),
    gating: common(input.results.map((result) => result.identities.case.gatingStatus)),
    identities: {
      corpus: first.identities.corpus.hash,
      agentConfiguration: first.identities.agentConfiguration.hash,
      commit: first.identities.agentConfiguration.gitCommit,
      model: `${first.identities.agentConfiguration.provider}/${first.identities.agentConfiguration.model}`,
      evaluator: evaluatorIdentity,
      rubric: rubricIdentity,
      runner: first.identities.runner.hash,
      repetition: repetitions,
    },
    cases: input.results.map((result) => {
      const evaluationCase = caseMap.get(`${result.identities.case.id}@${result.identities.case.version}`);
      if (!evaluationCase) throw new Error(`Missing case source for ${result.identities.case.id}`);
      return {
        caseId: evaluationCase.id,
        caseVersion: String(evaluationCase.version),
        repetition: result.identities.repetition,
        input: {
          turns: evaluationCase.inputs.turns,
          assets: evaluationCase.inputs.assets.map(({ id, mimeType, sha256, provenance, expectedRole }) => ({
            id,
            mimeType,
            sha256,
            provenance,
            expectedRole,
          })),
        },
        expectedOutput: evaluationCase.expectedOutcome,
        output: {
          execution: result.execution,
          outcome: result.outcome,
          evidence: result.evidence.map(({ id, kind }) => ({ id, kind })),
          scores: result.scores,
          measurements: result.measurements,
          integrity: result.integrity,
        },
        taskOutcome: result.outcome.kind,
        measurements: measurements(result),
      };
    }),
  };
}
