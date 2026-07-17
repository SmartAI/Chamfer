import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { basename, resolve } from "node:path";
import {
  compareCohorts,
  isEvaluationResultFilename,
  renderCohortComparison,
  type ReleaseThresholdPolicy,
} from "./comparison";
import { parseEvaluationResult, type EvaluationResult } from "./result";
import type { PrivacyScan } from "./privacy";
import { canonicalJson } from "./identity";
import type { CohortVerdict } from "./verdict";
import { validatePrivateArtifactOutput } from "./artifactPaths";

function requiredArgument(name: string): string {
  const prefix = `--${name}=`;
  const value = process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
  if (!value) throw new Error(`Missing required argument ${name}`);
  return resolve(value);
}

function optionalArgument(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  return resolve(process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length) ?? fallback);
}

async function loadResults(directory: string): Promise<EvaluationResult[]> {
  const files = (await readdir(directory)).filter(isEvaluationResultFilename).sort();
  const results: EvaluationResult[] = [];
  for (const file of files) {
    const value = JSON.parse(await readFile(resolve(directory, file), "utf8")) as Record<string, unknown>;
    results.push(parseEvaluationResult(value));
  }
  if (results.length === 0) throw new Error(`No evaluation result files found in ${basename(directory)}`);
  return results;
}

async function loadPrivacy(directory: string): Promise<PrivacyScan> {
  return JSON.parse(await readFile(resolve(directory, "privacy-scan.json"), "utf8")) as PrivacyScan;
}

async function loadVerdict(directory: string): Promise<CohortVerdict> {
  const verdict = JSON.parse(await readFile(resolve(directory, "cohort-verdict.json"), "utf8")) as CohortVerdict;
  if (!Array.isArray(verdict.requiredAttempts)) {
    throw new Error(`Cohort verdict in ${basename(directory)} lacks its declared attempt schedule`);
  }
  return verdict;
}

const repoRoot = resolve(import.meta.dirname, "../../..");
const candidateDirectory = requiredArgument("candidate");
const controlDirectory = requiredArgument("control");
const outputDirectory = optionalArgument(
  "output",
  resolve(repoRoot, "docs/internal/evaluations/comparisons", new Date().toISOString().replaceAll(":", "-")),
);
const policyPath = optionalArgument("policy", resolve(import.meta.dirname, "policies/release-v1.json"));
validatePrivateArtifactOutput(repoRoot, outputDirectory);
const [candidate, control, candidatePrivacy, controlPrivacy, candidateVerdict, controlVerdict, policy] = await Promise.all([
  loadResults(candidateDirectory),
  loadResults(controlDirectory),
  loadPrivacy(candidateDirectory),
  loadPrivacy(controlDirectory),
  loadVerdict(candidateDirectory),
  loadVerdict(controlDirectory),
  readFile(policyPath, "utf8").then((value) => JSON.parse(value) as ReleaseThresholdPolicy),
]);
if (canonicalJson(candidateVerdict.requiredAttempts) !== canonicalJson(controlVerdict.requiredAttempts)) {
  throw new Error("Candidate and control declared different attempt schedules");
}
const comparison = compareCohorts({
  candidate,
  control,
  requiredAttempts: candidateVerdict.requiredAttempts,
  candidatePrivacy,
  controlPrivacy,
  policy,
});
await mkdir(outputDirectory, { recursive: true });
await Promise.all([
  writeFile(resolve(outputDirectory, "comparison.json"), `${JSON.stringify(comparison, null, 2)}\n`),
  writeFile(resolve(outputDirectory, "comparison.md"), renderCohortComparison(comparison)),
]);
console.log(`Comparison verdict: ${comparison.status}`);
console.log(`Comparison artifacts: ${outputDirectory}`);
if (!comparison.passes) process.exitCode = 1;
