import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { safeEvaluationArtifactPath } from "./artifacts";
import { runDeterministicFixtures } from "./deterministicFixtures";
import { assertPrivacySafe } from "./privacy";
import { evaluateThroughProductionSession, PlaywrightProductionSession } from "./productionSession";
import { calculateReleaseGate } from "./releaseGate";
import { parseReleaseEvaluationCorpus, type EvaluationTask } from "./schema";
import {
  aggregateRuns,
  scoreObservation,
  type EvaluationObservation,
  type ScoredRun,
} from "./scoring";

const RUNNER_VERSION = 1;
const sourceDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(sourceDir, "../../..");

function argument(name: string, fallback = ""): string {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function errorObservation(task: EvaluationTask, promptVersion: string): EvaluationObservation {
  return {
    provider: task.modelConfiguration.provider,
    model: task.modelConfiguration.model,
    promptVersion,
    latencyMs: 0,
    tokenUse: { input: 0, output: 0, total: 0 },
    cadRunCount: 0,
    finalStatus: "error",
    evidence: [],
    proofIdentities: {
      proofPolicyId: task.proofPolicy.id,
      proofPolicyVersion: task.proofPolicy.version,
    },
    infrastructureError: "production-session-failed",
  };
}

const baseUrl = argument("url", "http://localhost:5273");
const corpusPath = resolve(repoRoot, argument("corpus", "packages/evaluation/corpus/proven-single-part-v1.json"));
const selectedTaskIds = argument("case").split(",").filter(Boolean);
const repetitionsOverride = argument("repetitions");
const injectedFalseProvenTask = argument("inject-false-proven");
const stamp = new Date().toISOString().replace(/[.:]/g, "-");
const outputDir = safeEvaluationArtifactPath(
  repoRoot,
  argument("output", `docs/internal/evaluations/tracer-${stamp}`),
);
const promptVersion = digest(await readFile(resolve(repoRoot, "packages/client/src/agent/prompt.ts"), "utf8"));

const rawCorpus = JSON.parse(await readFile(corpusPath, "utf8")) as unknown;
assertPrivacySafe(rawCorpus, "Evaluation fixture corpus");
const corpus = parseReleaseEvaluationCorpus(rawCorpus);
const deterministicFixturePath = resolve(
  repoRoot,
  "packages/evaluation",
  corpus.releasePolicy.deterministicFixturePath,
);
const rawDeterministicFixtures = JSON.parse(await readFile(deterministicFixturePath, "utf8")) as unknown;
assertPrivacySafe(rawDeterministicFixtures, "Deterministic evaluator fixtures");
const deterministicFixtures = runDeterministicFixtures(rawDeterministicFixtures);
const tasks = selectedTaskIds.length > 0
  ? corpus.tasks.filter((task) => selectedTaskIds.includes(task.id))
  : corpus.tasks;
if (tasks.length !== (selectedTaskIds.length || corpus.tasks.length)) {
  throw new Error(`Evaluation task selection did not match every requested id: ${selectedTaskIds.join(",")}`);
}
if (injectedFalseProvenTask && !tasks.some((task) => task.id === injectedFalseProvenTask)) {
  throw new Error(`False-proven injection task is not selected: ${injectedFalseProvenTask}`);
}
const repetitions = repetitionsOverride ? Number(repetitionsOverride) : undefined;
if (repetitions !== undefined && (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 20)) {
  throw new Error("--repetitions must be an integer from 1 to 20");
}

const browser = await chromium.launch({ headless: true });
const runs: ScoredRun[] = [];
const context = await browser.newContext();
const page = await context.newPage();
const productionSession = new PlaywrightProductionSession(page, baseUrl);
try {
  for (const task of tasks) {
    const runCount = repetitions ?? task.modelConfiguration.repetitions;
    for (let repetition = 1; repetition <= runCount; repetition += 1) {
      let observation: EvaluationObservation;
      let trace: ScoredRun["trace"] = [];
      try {
        const analyzed = await evaluateThroughProductionSession(
          productionSession,
          task,
          promptVersion,
        );
        observation = analyzed.observation;
        trace = analyzed.trace;
      } catch (error) {
        console.error(`${task.id} repetition ${repetition} failed:`, error);
        observation = errorObservation(task, promptVersion);
      }
      if (task.id === injectedFalseProvenTask) observation = { ...observation, finalStatus: "proven" };
      const score = scoreObservation(task, observation);
      runs.push({
        taskId: task.id,
        taskVersion: task.taskVersion,
        category: task.category,
        repetition,
        observation,
        score,
        trace,
      });
      console.log(`${task.id} repetition ${repetition}: ${observation.finalStatus} (${score.passed ? "pass" : "fail"})`);
    }
  }
} finally {
  await context.close().catch(() => undefined);
  await browser.close();
}

const aggregate = aggregateRuns(runs);
const releaseGate = calculateReleaseGate({
  corpus,
  runs,
  deterministicFixtures,
  privacyScanPassed: true,
});
const runReport = {
  schemaVersion: 1,
  runnerVersion: RUNNER_VERSION,
  corpusId: corpus.corpusId,
  corpusVersion: corpus.corpusVersion,
  runs,
};
const aggregateReport = {
  schemaVersion: 1,
  runnerVersion: RUNNER_VERSION,
  corpusId: corpus.corpusId,
  corpusVersion: corpus.corpusVersion,
  promptVersion,
  aggregate,
  releaseGate,
};
assertPrivacySafe(runReport, "Generated run report");
assertPrivacySafe(aggregateReport, "Generated aggregate report");
assertPrivacySafe(releaseGate.inventory, "Generated corpus inventory");
assertPrivacySafe(deterministicFixtures, "Generated deterministic fixture report");
assertPrivacySafe(releaseGate, "Generated release-gate report");
const privacyReport = {
  schemaVersion: 1,
  corpusId: corpus.corpusId,
  corpusVersion: corpus.corpusVersion,
  fixtureScan: "passed",
  generatedReportScan: "passed",
  deterministicFixtureScan: "passed",
  scannedRunCount: runs.length,
  sourceSafetyCounts: releaseGate.inventory.sourceSafetyCounts,
};
assertPrivacySafe(privacyReport, "Generated privacy report");

await mkdir(outputDir, { recursive: true });
await writeFile(resolve(outputDir, "runs.json"), `${JSON.stringify(runReport, null, 2)}\n`);
await writeFile(resolve(outputDir, "aggregate.json"), `${JSON.stringify(aggregateReport, null, 2)}\n`);
await writeFile(resolve(outputDir, "corpus-inventory.json"), `${JSON.stringify(releaseGate.inventory, null, 2)}\n`);
await writeFile(resolve(outputDir, "deterministic-fixtures.json"), `${JSON.stringify(deterministicFixtures, null, 2)}\n`);
await writeFile(resolve(outputDir, "release-gate.json"), `${JSON.stringify(releaseGate, null, 2)}\n`);
await writeFile(resolve(outputDir, "privacy-scan.json"), `${JSON.stringify(privacyReport, null, 2)}\n`);
console.log(`Wrote private evaluation artifacts to ${relative(repoRoot, outputDir)}`);
console.log(`Release eligible: ${releaseGate.releaseEligible}; false-proven outcomes: ${releaseGate.falseProvenCount}`);
if (!releaseGate.releaseEligible) console.log(`Release blockers: ${releaseGate.reasons.join(", ")}`);

process.exitCode = releaseGate.releaseEligible || hasFlag("allow-score-failures") ? 0 : 2;
