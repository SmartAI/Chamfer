import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { buildPairedAttemptSchedule, type AttemptScheduleEntry } from "./cohort";
import type { PrivacyScan } from "./privacy";
import { calculateCohortVerdict } from "./verdict";
import { runEvaluation, writeRunSummaries, type EvaluationRun } from "./runner";
import type { EvaluationResult } from "./result";
import type { EvaluationCase } from "./schema";
import { buildOfflineExperimentCohort } from "./offlineCohort";

export interface PairedRunPlanEntry {
  cohort: "candidate" | "control";
  productRoot: string;
  attempt: AttemptScheduleEntry;
}

export function buildPairedRunPlan(input: {
  cases: Array<{ id: string; version: number }>;
  repetitions: number;
  seed: number;
  candidateRoot: string;
  controlRoot: string;
}): PairedRunPlanEntry[] {
  const roots = {
    candidate: resolve(input.candidateRoot),
    control: resolve(input.controlRoot),
  };
  return buildPairedAttemptSchedule(input.cases, input.repetitions, input.seed).map(({ cohort, ...attempt }) => ({
    cohort,
    productRoot: roots[cohort],
    attempt,
  }));
}

function mergePrivacy(scans: PrivacyScan[]): PrivacyScan {
  const findings = scans.flatMap((scan) => scan.findings);
  return { status: findings.length > 0 ? "failed" : "passed", findings };
}

async function finalizeCohort(input: {
  outputDir: string;
  results: EvaluationResult[];
  scans: PrivacyScan[];
  requiredAttempts: AttemptScheduleEntry[];
  cases: EvaluationCase[];
}): Promise<EvaluationRun> {
  const cohortContent = `${JSON.stringify(buildOfflineExperimentCohort({
    results: input.results,
    cases: input.cases,
  }), null, 2)}\n`;
  const privacy = mergePrivacy(input.scans);
  const verdict = calculateCohortVerdict({ results: input.results, requiredAttempts: input.requiredAttempts, privacy });
  if (privacy.status === "passed") {
    await writeFile(resolve(input.outputDir, "offline-cohort.json"), cohortContent, { mode: 0o600 });
  }
  await writeRunSummaries(input.outputDir, privacy, verdict);
  return { results: input.results, privacy, verdict };
}

export async function runPairedEvaluation(options: {
  repoRoot: string;
  candidateRoot: string;
  controlRoot: string;
  candidateExpectedCommit?: string;
  controlExpectedCommit?: string;
  casePaths: string[];
  cases: EvaluationCase[];
  outputDir: string;
  clientPort: number;
  apiPort: number;
  depth: "targeted" | "release";
  repetitions: number;
  seed: number;
}): Promise<{ candidate: EvaluationRun; control: EvaluationRun }> {
  const plan = buildPairedRunPlan(options);
  const results = { candidate: [] as EvaluationResult[], control: [] as EvaluationResult[] };
  const scans = { candidate: [] as PrivacyScan[], control: [] as PrivacyScan[] };
  const output = {
    candidate: resolve(options.outputDir, "candidate"),
    control: resolve(options.outputDir, "control"),
  };
  for (const entry of plan) {
    const run = await runEvaluation({
      repoRoot: options.repoRoot,
      productRoot: entry.productRoot,
      expectedProductCommit: entry.cohort === "candidate"
        ? options.candidateExpectedCommit
        : options.controlExpectedCommit,
      casePaths: options.casePaths,
      outputDir: output[entry.cohort],
      clientPort: options.clientPort,
      apiPort: options.apiPort,
      depth: options.depth,
      repetitions: options.repetitions,
      seed: options.seed,
      attemptSchedule: [entry.attempt],
    });
    results[entry.cohort].push(...run.results);
    scans[entry.cohort].push(run.privacy);
  }
  const requiredAttempts = buildPairedAttemptSchedule(options.cases, options.repetitions, options.seed)
    .filter((entry) => entry.cohort === "candidate")
    .map(({ cohort: _cohort, ...attempt }) => attempt);
  return {
    candidate: await finalizeCohort({
      outputDir: output.candidate,
      results: results.candidate,
      scans: scans.candidate,
      requiredAttempts,
      cases: options.cases,
    }),
    control: await finalizeCohort({
      outputDir: output.control,
      results: results.control,
      scans: scans.control,
      requiredAttempts,
      cases: options.cases,
    }),
  };
}
