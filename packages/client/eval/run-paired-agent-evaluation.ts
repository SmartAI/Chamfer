import { resolve } from "node:path";
import { runPairedEvaluation } from "./paired";
import { loadEvaluationCase } from "./schema";
import { existsSync } from "node:fs";
import { loadEvaluationDotenv, resolveCliPath } from "./runtime";

const repoRoot = resolve(import.meta.dirname, "../../..");
loadEvaluationDotenv(repoRoot);

function cliPath(value: string): string {
  return resolveCliPath({ value, cwd: process.cwd(), repoRoot, cwdPathExists: existsSync(resolve(value)) });
}

function argument(name: string, fallback?: string): string {
  const prefix = `--${name}=`;
  const value = process.argv.find((candidate) => candidate.startsWith(prefix))?.slice(prefix.length) ?? fallback;
  if (value === undefined || value === "") throw new Error(`Missing required argument ${name}`);
  return value;
}

function integerArgument(name: string, fallback: number): number {
  const value = Number(argument(name, String(fallback)));
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

const casePaths = argument("cases", resolve(import.meta.dirname, "cases/v1/precise-box.case.json"))
  .split(",")
  .map(cliPath);
const cases = await Promise.all(casePaths.map(loadEvaluationCase));
const depth = argument("depth", "targeted");
if (depth !== "targeted" && depth !== "release") throw new Error(`Unknown paired evaluation depth ${depth}`);
const outputDir = cliPath(argument(
  "output",
  resolve(repoRoot, "docs/internal/evaluations/paired", new Date().toISOString().replaceAll(":", "-")),
));

const run = await runPairedEvaluation({
  repoRoot,
  candidateRoot: cliPath(argument("candidate-root", repoRoot)),
  controlRoot: cliPath(argument("control-root")),
  candidateExpectedCommit: argument("candidate-commit", "") || undefined,
  controlExpectedCommit: argument("control-commit", "") || undefined,
  casePaths,
  cases,
  outputDir,
  clientPort: integerArgument("client-port", 5373),
  apiPort: integerArgument("api-port", 8987),
  depth,
  repetitions: integerArgument("repetitions", depth === "release" ? 3 : 1),
  seed: integerArgument("seed", 1),
});

console.log(`Candidate verdict: ${run.candidate.verdict.status}`);
console.log(`Control verdict: ${run.control.verdict.status}`);
console.log(`Paired evaluation artifacts: ${outputDir}`);
if (!run.candidate.verdict.passes || !run.control.verdict.passes) process.exitCode = 1;
