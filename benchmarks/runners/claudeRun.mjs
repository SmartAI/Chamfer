#!/usr/bin/env node
// One Claude Code attempt on a golden benchmark case (the "claude" reference
// arm): the CLI spawns a fresh stdio build123d-mcp instance (derived from the
// arm's mcp.json), the agent builds + exports STEP to <runDir>/design.step,
// and the oracle grades the STEP.
//
// Usage:
//   node benchmarks/runners/claudeRun.mjs --case=GOLD-T0-BOX [--model=...]
//     [--arm-dir=benchmarks/arms/v0]
//     [--cases-file=benchmarks/golden/v1/cases.json] [--timeout-min=22]
//     [--run-dir=<dir>]
// Credentials: ANTHROPIC_API_KEY (required), ANTHROPIC_BASE_URL (optional),
// both strictly from the process environment. All inherited ANTHROPIC_*/
// CLAUDE_*/CLAUDECODE vars are scrubbed from the child env first.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  arg,
  B123_TOOLS,
  buildMetrics,
  DEFAULT_ARM_DIR,
  DEFAULT_CASES_FILE,
  detectOverClaim,
  finishRun,
  loadCase,
  makeRunDir,
  requireCreds,
  runOracle,
} from "./lib.mjs";

const caseId = arg("case", "GOLD-T0-BOX");
const timeoutMin = Number(arg("timeout-min", process.env.CHAMFER_BENCH_TIMEOUT_MIN || "22"));
const model = arg("model", process.env.CHAMFER_BENCH_MODEL || "claude-opus-4-8");
const armDir = path.resolve(arg("arm-dir", DEFAULT_ARM_DIR));
const casesFile = path.resolve(arg("cases-file", DEFAULT_CASES_FILE));

requireCreds();
const kase = loadCase(casesFile, caseId);

const runDirArg = arg("run-dir", "");
const runDir = runDirArg ? path.resolve(runDirArg) : makeRunDir("claude", caseId);
fs.mkdirSync(runDir, { recursive: true });
const exportPath = path.join(runDir, "design.step");
const prompt = kase.prompt.replaceAll("{EXPORT_PATH}", exportPath);
const systemPrompt = fs.readFileSync(path.join(armDir, "system-prompt.txt"), "utf8");

// Derive the Claude CLI MCP config from the arm's adapter mcp.json so both
// arms share one source of truth for the server command; generated per run.
const armMcp = JSON.parse(fs.readFileSync(path.join(armDir, "mcp.json"), "utf8"));
const b123 = armMcp.mcpServers?.b123;
if (!b123?.command) {
  console.error(`arm mcp.json at ${armDir} has no mcpServers.b123.command`);
  process.exit(1);
}
const mcpConfigPath = path.join(runDir, "mcp-config.claude.json");
fs.writeFileSync(
  mcpConfigPath,
  JSON.stringify({ mcpServers: { b123: { type: "stdio", command: b123.command, args: b123.args || [] } } }, null, 2),
);

function parseStreamJson(stdout, proc) {
  const lines = (stdout || "").split("\n").filter((l) => l.trim());
  let resultEvent = null;
  let latestUsage = null;
  let numAssistant = 0;
  const toolCalls = {};
  const finalTexts = [];
  for (const line of lines) {
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.type === "assistant") {
      numAssistant++;
      const msg = o.message || {};
      if (msg.usage) latestUsage = msg.usage;
      for (const c of msg.content || []) {
        if (c.type === "tool_use") toolCalls[c.name] = (toolCalls[c.name] || 0) + 1;
        if (c.type === "text" && c.text) finalTexts.push(c.text);
      }
    } else if (o.type === "result") {
      resultEvent = o;
    }
  }
  const capped = !!(proc.error && String(proc.error).includes("ETIMEDOUT"));
  const mcpCalls = Object.entries(toolCalls).filter(([k]) => k.startsWith("mcp__b123__"));
  return {
    completed: !!resultEvent && !capped,
    cappedByTimeout: capped,
    num_turns: resultEvent?.num_turns ?? numAssistant,
    cost_usd: resultEvent?.total_cost_usd ?? null,
    usage: resultEvent?.usage ?? latestUsage,
    result: resultEvent?.result ?? finalTexts.slice(-1)[0] ?? null,
    is_error: resultEvent?.is_error ?? null,
    b123Calls: mcpCalls.reduce((a, [, v]) => a + v, 0),
    executeCalls: toolCalls["mcp__b123__execute"] || 0,
    toolCalls,
  };
}

const t0 = Date.now();
const args = [
  "-p",
  prompt,
  "--model",
  model,
  "--mcp-config",
  mcpConfigPath,
  "--strict-mcp-config",
  "--allowedTools",
  ...B123_TOOLS.map((t) => `mcp__b123__${t}`),
  "--disallowedTools",
  "Bash",
  "Write",
  "Edit",
  "Read",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "Task",
  "NotebookEdit",
  "--permission-mode",
  "bypassPermissions",
  "--append-system-prompt",
  systemPrompt,
  "--output-format",
  "stream-json",
  "--verbose",
];
// Scrub every inherited ANTHROPIC_/CLAUDE_/CLAUDECODE var (a parent Claude
// Code session leaks these), then inject exactly the two cred vars.
const childEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !/^(ANTHROPIC_|CLAUDE_|CLAUDECODE)/.test(k)),
);
childEnv.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if ((process.env.ANTHROPIC_BASE_URL || "").trim()) childEnv.ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL;

const proc = spawnSync("claude", args, {
  cwd: runDir,
  env: childEnv,
  encoding: "utf8",
  maxBuffer: 256 * 1024 * 1024,
  timeout: timeoutMin * 60 * 1000,
});
const agentOut = parseStreamJson(proc.stdout, proc);
const wallMs = Date.now() - t0;

const grade = runOracle(exportPath, caseId, casesFile, kase.checks.length);
const overClaim = detectOverClaim(agentOut.result, grade);
const u = agentOut.usage || {};
const metrics = buildMetrics({
  grade,
  overClaim,
  costUsd: agentOut.cost_usd,
  tokens: {
    in: u.input_tokens || 0,
    out: u.output_tokens || 0,
    cacheRead: u.cache_read_input_tokens || 0,
    cacheWrite: u.cache_creation_input_tokens || 0,
  },
  toolCallsTotal: Object.values(agentOut.toolCalls).reduce((a, v) => a + v, 0),
  executes: agentOut.executeCalls,
  wallMs,
});

const record = {
  case: caseId,
  agent: "claude",
  model,
  wallMs,
  exportPath,
  exported: fs.existsSync(exportPath),
  grade,
  metrics,
  agentOut,
};
finishRun({ runDir, proc, grade, record });

console.log(
  JSON.stringify(
    {
      runDir,
      wallMs: Math.round(wallMs / 1000) + "s",
      exported: record.exported,
      grade: grade.checks ? `${grade.passed}/${grade.total}` : grade,
      failed: metrics.checksFailed,
      overClaim,
      agent: {
        completed: agentOut.completed,
        cappedByTimeout: agentOut.cappedByTimeout,
        turns: agentOut.num_turns,
        b123Calls: agentOut.b123Calls,
        executeCalls: agentOut.executeCalls,
        cost_usd: agentOut.cost_usd,
        result: (agentOut.result || "").slice(0, 300),
      },
    },
    null,
    2,
  ),
);
process.exit(0);
