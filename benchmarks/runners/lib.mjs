// Shared helpers for the golden-benchmark runners.
//
// Public-safe by construction: no personal absolute paths (everything resolves
// from this file's location), no credentials on disk (ANTHROPIC_API_KEY and the
// optional ANTHROPIC_BASE_URL come strictly from the process environment), and
// the oracle's Python is CHAMFER_BENCH_PYTHON or the repo's py-tests venv.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const BENCH_DIR = path.join(REPO_ROOT, "benchmarks");
export const RESULTS_DIR = path.join(BENCH_DIR, "results");
export const TMP_RUNS_DIR = path.join(RESULTS_DIR, "tmp-runs");
export const PI_HOME_DIR = path.join(RESULTS_DIR, ".pi-home");
export const ORACLE_PATH = path.join(BENCH_DIR, "oracle", "oracle.py");
export const DEFAULT_CASES_FILE = path.join(BENCH_DIR, "golden", "v1", "cases.json");
export const DEFAULT_ARM_DIR = path.join(BENCH_DIR, "arms", "v0");

export const B123_TOOLS = ["execute", "last_error", "inspect_part", "measure", "render_view", "export"];

export function arg(name, def) {
  const p = `--${name}=`;
  return process.argv.find((a) => a.startsWith(p))?.slice(p.length) ?? def;
}

export function requireCreds() {
  if (!(process.env.ANTHROPIC_API_KEY || "").trim()) {
    console.error(
      [
        "Missing credentials: ANTHROPIC_API_KEY is not set in the environment.",
        "The runners read credentials from process env only (never from files).",
        "Export ANTHROPIC_API_KEY (and optionally ANTHROPIC_BASE_URL) and re-run, e.g.:",
        "  export ANTHROPIC_API_KEY=sk-ant-...",
      ].join("\n"),
    );
    process.exit(1);
  }
}

export function oraclePython() {
  return (
    (process.env.CHAMFER_BENCH_PYTHON || "").trim() ||
    path.join(REPO_ROOT, "py-tests", ".venv", "bin", "python")
  );
}

export function loadCase(casesFile, caseId) {
  const cases = JSON.parse(fs.readFileSync(casesFile, "utf8")).cases;
  const kase = cases.find((c) => c.id === caseId);
  if (!kase) {
    console.error(`case ${caseId} not found in ${casesFile}`);
    process.exit(1);
  }
  return kase;
}

export function makeRunDir(armName, caseId) {
  const dir = path.join(TMP_RUNS_DIR, `${armName}-${caseId}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Isolated pi home under results/ (git-ignored). settings.json pulls in
// pi-mcp-adapter so pi can read the arm's .mcp.json; models.json overrides the
// anthropic base URL ONLY when ANTHROPIC_BASE_URL is set, and is regenerated
// every invocation so a stale private URL never lingers. Never commit this dir.
export function ensurePiHome() {
  fs.mkdirSync(PI_HOME_DIR, { recursive: true });
  const settingsPath = path.join(PI_HOME_DIR, "settings.json");
  if (!fs.existsSync(settingsPath)) {
    fs.writeFileSync(settingsPath, JSON.stringify({ packages: ["npm:pi-mcp-adapter"] }, null, 2) + "\n");
  }
  const modelsPath = path.join(PI_HOME_DIR, "models.json");
  const baseUrl = (process.env.ANTHROPIC_BASE_URL || "").trim();
  if (baseUrl) {
    fs.writeFileSync(
      modelsPath,
      JSON.stringify({ providers: { anthropic: { baseUrl } } }, null, 2) + "\n",
    );
  } else if (fs.existsSync(modelsPath)) {
    fs.rmSync(modelsPath);
  }
  return PI_HOME_DIR;
}

export function runOracle(exportPath, caseId, casesFile, checksTotal) {
  if (!fs.existsSync(exportPath)) {
    return { error: "no exported STEP", passed: 0, total: checksTotal };
  }
  const py = oraclePython();
  if (!fs.existsSync(py)) {
    return {
      error:
        `oracle python not found at ${py}; create the repo venv ` +
        "(py-tests/.venv with build123d) or set CHAMFER_BENCH_PYTHON",
      passed: 0,
      total: checksTotal,
    };
  }
  const g = spawnSync(py, [ORACLE_PATH, exportPath, caseId, "--cases", casesFile], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 300_000,
  });
  try {
    return JSON.parse(g.stdout);
  } catch {
    return { error: "oracle failed", stderr: (g.stderr || "").slice(-800), passed: 0, total: checksTotal };
  }
}

// Over-claim: the agent's final message does not admit failure while the oracle
// grade is below 100%. An empty/missing final message (crash, timeout) claims
// nothing and is not counted as an over-claim.
export function detectOverClaim(finalText, grade) {
  const passed = grade?.passed ?? 0;
  const total = grade?.total ?? 0;
  if (total > 0 && passed >= total) return false;
  const text = (finalText || "").trim();
  if (!text) return false;
  return !/unable|blocked/i.test(text);
}

// Uniform per-run metrics block consumed by runBatch.mjs.
export function buildMetrics({ grade, overClaim, costUsd, tokens, toolCallsTotal, executes, wallMs }) {
  return {
    passed: grade?.passed ?? 0,
    total: grade?.total ?? 0,
    checksFailed: grade?.checks ? grade.checks.filter((c) => c.status !== "passed").map((c) => c.id) : null,
    overClaim,
    costUsd,
    tokens,
    toolCalls: toolCallsTotal,
    executes,
    latencySec: Math.round(wallMs / 100) / 10,
  };
}

export function finishRun({ runDir, proc, grade, record }) {
  fs.writeFileSync(path.join(runDir, "transcript.jsonl"), proc.stdout || "");
  if (proc.stderr) fs.writeFileSync(path.join(runDir, "stderr.log"), proc.stderr);
  fs.writeFileSync(path.join(runDir, "grade.json"), JSON.stringify(grade, null, 2));
  fs.writeFileSync(path.join(runDir, "record.json"), JSON.stringify(record, null, 2));
}
