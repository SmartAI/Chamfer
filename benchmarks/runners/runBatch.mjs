#!/usr/bin/env node
// Sequential batch driver for the golden benchmark.
//
// Runs one arm (pi, claude, or codex) over the selected cases, N reps each,
// strictly sequentially, and aggregates every run's metrics into
// benchmarks/results/<UTC-stamp>-<arm>-<model>/summary.json. Per-run artifacts
// (transcript, STEP, record.json, grade.json) stay under
// benchmarks/results/tmp-runs/ which is git-ignored; only summary.json dirs
// are ever committed.
//
// Usage:
//   node benchmarks/runners/runBatch.mjs --arm=pi --cases=GOLD-T0-BOX --reps=1
//   node benchmarks/runners/runBatch.mjs --arm=claude --cases=all --reps=3 \
//     --model=claude-opus-4-8 [--arm-dir=benchmarks/arms/v0] \
//     [--cases-file=benchmarks/private/cases.json] [--timeout-min=22]
//   node benchmarks/runners/runBatch.mjs --arm=codex --cases=all --reps=3 \
//     --model=gpt-5.6-luna [--reasoning=high]
// Credentials, strictly from the process environment:
//   pi/claude arms: ANTHROPIC_API_KEY (required), ANTHROPIC_BASE_URL (optional)
//   codex arm:      OPENAI_API_KEY (required), OPENAI_BASE_URL (optional)
// Codex speaks the OpenAI Responses wire API only - it cannot run
// Anthropic/Claude models (see codexRun.mjs; recorded in summary.json as
// modelFamily/modelFamilyNote).
//
// Warm-up (pi arm): the first pi session against a fresh cwd/.mcp.json can
// expose only the adapter's proxy tool until the MCP metadata is cached in the
// pi home. Before any timed run we therefore do a throwaway pi run in a
// scratch dir with the same .mcp.json asking it to list its tool names, and
// assert all six direct b123 tools appear. The very first attempt on a cold
// home may legitimately show only the proxy tool (it is what populates the
// cache), so we allow one retry before aborting.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  arg,
  B123_TOOLS,
  DEFAULT_ARM_DIR,
  DEFAULT_CASES_FILE,
  ensurePiHome,
  requireCreds,
  REPO_ROOT,
  RESULTS_DIR,
  TMP_RUNS_DIR,
} from "./lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const arm = arg("arm", "pi");
if (!["pi", "claude", "codex"].includes(arm)) {
  console.error(`--arm must be "pi", "claude", or "codex", got "${arm}"`);
  process.exit(1);
}
const armDir = path.resolve(arg("arm-dir", DEFAULT_ARM_DIR));
const casesFile = path.resolve(arg("cases-file", DEFAULT_CASES_FILE));
const casesArg = arg("cases", "all");
const reps = Number(arg("reps", "1"));
const provider = arg("provider", process.env.CHAMFER_BENCH_PROVIDER || "anthropic");
// The codex arm speaks the OpenAI Responses wire API only and cannot run
// Anthropic/Claude models, so its model default differs (see codexRun.mjs).
const model =
  arm === "codex"
    ? arg("model", process.env.CHAMFER_BENCH_CODEX_MODEL || "gpt-5.6-luna")
    : arg("model", process.env.CHAMFER_BENCH_MODEL || "claude-opus-4-8");
const reasoning = arg("reasoning", "high"); // codex arm only
const thinking = arg("thinking", process.env.CHAMFER_BENCH_THINKING || ""); // pi arm only
const timeoutMin = arg("timeout-min", process.env.CHAMFER_BENCH_TIMEOUT_MIN || "22");

if (arm === "codex") {
  if (!(process.env.OPENAI_API_KEY || "").trim()) {
    console.error(
      "Missing credentials: OPENAI_API_KEY is not set in the environment (required for --arm=codex).\n" +
        "Export OPENAI_API_KEY (and optionally OPENAI_BASE_URL for a gateway) and re-run.",
    );
    process.exit(1);
  }
} else {
  requireCreds();
}
if (!fs.existsSync(path.join(armDir, "mcp.json")) || !fs.existsSync(path.join(armDir, "system-prompt.txt"))) {
  console.error(`arm dir ${armDir} must contain mcp.json and system-prompt.txt`);
  process.exit(1);
}

const allCases = JSON.parse(fs.readFileSync(casesFile, "utf8")).cases;
const caseIds =
  casesArg === "all"
    ? allCases.map((c) => c.id)
    : casesArg
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
for (const id of caseIds) {
  if (!allCases.some((c) => c.id === id)) {
    console.error(`case ${id} not found in ${casesFile}`);
    process.exit(1);
  }
}
if (!Number.isInteger(reps) || reps < 1) {
  console.error(`--reps must be a positive integer, got "${arg("reps", "1")}"`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Warm-up (pi arm only; the claude arm has no adapter metadata cache)
// ---------------------------------------------------------------------------
function extractAssistantText(stdout) {
  const texts = [];
  for (const line of (stdout || "").split("\n")) {
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.type === "message_end" && o.message?.role === "assistant") {
      for (const c of o.message.content || []) if (c.type === "text" && c.text) texts.push(c.text);
    }
  }
  return texts.join("\n");
}

function warmUpPiArm() {
  const piHome = ensurePiHome();
  const scratch = path.join(TMP_RUNS_DIR, `warmup-pi-${Date.now()}`);
  fs.mkdirSync(scratch, { recursive: true });
  fs.copyFileSync(path.join(armDir, "mcp.json"), path.join(scratch, ".mcp.json"));
  const prompt =
    "List the names of every tool you currently have available, one per line, exactly as named. Do not call any tools.";
  const attempts = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    console.error(`[warmup] pi arm, attempt ${attempt}...`);
    const proc = spawnSync(
      "pi",
      [
        "-p",
        "--mode",
        "json",
        "--provider",
        provider,
        "--model",
        model,
        "--no-builtin-tools",
        "--no-skills",
        "--no-context-files",
        "--no-prompt-templates",
        "--no-themes",
        "--session-dir",
        scratch,
        "-a",
        prompt,
      ],
      {
        cwd: scratch,
        env: {
          HOME: process.env.HOME,
          PATH: process.env.PATH,
          TERM: "dumb",
          PI_CODING_AGENT_DIR: piHome,
          ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        },
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        timeout: 5 * 60 * 1000,
      },
    );
    fs.writeFileSync(path.join(scratch, `warmup-${attempt}.jsonl`), proc.stdout || "");
    const text = extractAssistantText(proc.stdout);
    const missing = B123_TOOLS.filter((t) => !text.includes(t));
    attempts.push({ attempt, missing, ok: missing.length === 0 });
    if (missing.length === 0) {
      console.error(`[warmup] ok on attempt ${attempt}: all six b123 tools visible`);
      return { ok: true, attempts, scratch: path.relative(REPO_ROOT, scratch) };
    }
    console.error(`[warmup] attempt ${attempt}: missing tools [${missing.join(", ")}]`);
  }
  console.error(
    [
      "[warmup] FAILED: the pi arm never exposed the six direct b123 tools",
      `(execute, last_error, inspect_part, measure, render_view, export).`,
      `Inspect the warm-up transcripts under ${scratch} - likely causes: pi-mcp-adapter`,
      "not installing into benchmarks/results/.pi-home, or the b123 server (uv tool run",
      "build123d-mcp) failing to start. Aborting before any timed run.",
    ].join("\n"),
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Batch
// ---------------------------------------------------------------------------
function mean(values) {
  const nums = values.filter((v) => typeof v === "number" && Number.isFinite(v));
  if (nums.length === 0) return null;
  return Math.round((nums.reduce((a, v) => a + v, 0) / nums.length) * 1000) / 1000;
}

const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
const outDir = path.join(RESULTS_DIR, `${stamp}-${arm}-${model}`);
fs.mkdirSync(outDir, { recursive: true });
const summaryPath = path.join(outDir, "summary.json");

const startedAt = new Date().toISOString();
const warmup = arm === "pi" ? warmUpPiArm() : null;

const RUNNERS = { pi: "piRun.mjs", claude: "claudeRun.mjs", codex: "codexRun.mjs" };
const runnerPath = path.join(HERE, RUNNERS[arm]);
const runs = [];

function writeSummary(finished) {
  const perCase = {};
  for (const id of caseIds) {
    const rows = runs.filter((r) => r.case === id);
    if (rows.length === 0) continue;
    perCase[id] = {
      reps: rows.length,
      means: {
        passed: mean(rows.map((r) => r.passed)),
        total: rows[0].total,
        costUsd: mean(rows.map((r) => r.costUsd)),
        tokensIn: mean(rows.map((r) => r.tokens?.in)),
        tokensOut: mean(rows.map((r) => r.tokens?.out)),
        tokensCacheRead: mean(rows.map((r) => r.tokens?.cacheRead)),
        tokensCacheWrite: mean(rows.map((r) => r.tokens?.cacheWrite)),
        toolCalls: mean(rows.map((r) => r.toolCalls)),
        executes: mean(rows.map((r) => r.executes)),
        latencySec: mean(rows.map((r) => r.latencySec)),
      },
      overClaimRate: Math.round((rows.filter((r) => r.overClaim).length / rows.length) * 1000) / 1000,
    };
  }
  const summary = {
    arm,
    provider: arm === "pi" ? provider : undefined,
    model,
    // Caveat for cross-arm rows: codex cannot run Anthropic/Claude models
    // (OpenAI Responses wire only), so a codex row is a different model family
    // by construction; compare on comparable, not identical, models.
    modelFamily: arm === "codex" ? "openai-responses" : undefined,
    modelFamilyNote:
      arm === "codex"
        ? "codex speaks the OpenAI Responses wire API only; it cannot run Anthropic/Claude models"
        : undefined,
    reasoning: arm === "codex" ? reasoning : undefined,
    thinking: arm === "pi" && thinking ? thinking : undefined,
    armDir: path.relative(REPO_ROOT, armDir),
    casesFile: path.relative(REPO_ROOT, casesFile),
    cases: caseIds,
    reps,
    timeoutMin: Number(timeoutMin),
    startedAt,
    finishedAt: finished ? new Date().toISOString() : null,
    warmup,
    runs,
    perCase,
  };
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
}

for (const id of caseIds) {
  for (let rep = 1; rep <= reps; rep++) {
    const runDir = path.join(TMP_RUNS_DIR, `${arm}-${id}-r${rep}-${Date.now()}`);
    fs.mkdirSync(runDir, { recursive: true });
    console.error(`[batch] ${arm} ${id} rep ${rep}/${reps} -> ${path.relative(REPO_ROOT, runDir)}`);
    const runnerArgs = [
      runnerPath,
      `--case=${id}`,
      `--model=${model}`,
      `--arm-dir=${armDir}`,
      `--cases-file=${casesFile}`,
      `--timeout-min=${timeoutMin}`,
      `--run-dir=${runDir}`,
    ];
    if (arm === "pi") runnerArgs.push(`--provider=${provider}`);
    if (arm === "pi" && thinking) runnerArgs.push(`--thinking=${thinking}`);
    if (arm === "codex") runnerArgs.push(`--reasoning=${reasoning}`);
    const proc = spawnSync("node", runnerArgs, { stdio: "inherit" });
    const recordPath = path.join(runDir, "record.json");
    let row;
    if (fs.existsSync(recordPath)) {
      const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
      row = { case: id, rep, runDir: path.relative(REPO_ROOT, runDir), ...record.metrics };
    } else {
      row = {
        case: id,
        rep,
        runDir: path.relative(REPO_ROOT, runDir),
        passed: 0,
        total: allCases.find((c) => c.id === id).checks.length,
        checksFailed: null,
        overClaim: false,
        costUsd: null,
        tokens: null,
        toolCalls: null,
        executes: null,
        latencySec: null,
        error: `runner produced no record.json (exit ${proc.status})`,
      };
    }
    runs.push(row);
    writeSummary(false); // crash-safe: persist after every run
  }
}

writeSummary(true);
console.log(JSON.stringify({ summary: path.relative(REPO_ROOT, summaryPath), runs: runs.length }, null, 2));
