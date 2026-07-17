import { resolve } from "node:path";
import { runEvaluation } from "./runner";
import { existsSync } from "node:fs";
import { loadEvaluationDotenv, resolveCliPath } from "./runtime";

const repoRoot = resolve(import.meta.dirname, "../../..");
loadEvaluationDotenv(repoRoot);

function cliPath(value: string): string {
  const cwdCandidate = resolve(value);
  return resolveCliPath({ value, cwd: process.cwd(), repoRoot, cwdPathExists: existsSync(cwdCandidate) });
}

function argument(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

function integerArgument(name: string, fallback: number): number {
  const value = Number(argument(name, String(fallback)));
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

const defaultCase = resolve(import.meta.dirname, "cases/v1/precise-box.case.json");
const casePaths = argument("cases", defaultCase).split(",").map(cliPath);
const depth = argument("depth", "scripted");
if (depth !== "scripted" && depth !== "targeted" && depth !== "release") {
  throw new Error(`Unknown evaluation depth ${depth}`);
}
const outputDir = cliPath(argument(
  "output",
  resolve(repoRoot, "docs/internal/evaluations", new Date().toISOString().replaceAll(":", "-")),
));
const productRoot = cliPath(argument("product-root", repoRoot));
const expectedProductCommit = argument("expected-product-commit", "") || undefined;

const run = await runEvaluation({
  repoRoot,
  casePaths,
  outputDir,
  clientPort: integerArgument("client-port", 5373),
  apiPort: integerArgument("api-port", 8987),
  depth,
  repetitions: integerArgument("repetitions", depth === "release" ? 3 : 1),
  seed: integerArgument("seed", 1),
  productRoot,
  expectedProductCommit,
});

for (const result of run.results) {
  console.log(`${result.identities.case.id}: ${result.execution.state}, ${result.outcome.kind}`);
}
console.log(`Verdict: ${run.verdict.status}`);
console.log(`Evaluation artifacts: ${outputDir}`);
if (!run.verdict.passes) {
  process.exitCode = 1;
}
