#!/usr/bin/env node
// One Codex CLI attempt on a golden benchmark case (the "codex" reference arm):
// headless `codex exec --json`, the same b123 stdio MCP server as the other
// arms (derived from the arm's mcp.json), export STEP to <runDir>/design.step,
// oracle grades it.
//
// MODEL FAMILY CAVEAT: Codex speaks the OpenAI Responses wire API only
// (`wire_api = "responses"`; the Chat Completions wire was removed), so this
// arm CANNOT run Anthropic/Claude models. Cross-arm comparison rows must pick
// models that are comparable, not identical, across families. Default model:
// gpt-5.6-luna.
//
// Isolation: a dedicated CODEX_HOME under benchmarks/results/.codex-home
// (git-ignored, generated at runtime - its config.toml embeds OPENAI_BASE_URL,
// which may be private). The user's ~/.codex is never touched. The home is
// persistent so Codex's one-time plugin/skill clone cost is paid once.
//
// Usage:
//   node benchmarks/runners/codexRun.mjs --case=GOLD-T0-BOX [--model=gpt-5.6-luna]
//     [--reasoning=high] [--arm-dir=benchmarks/arms/v0]
//     [--cases-file=benchmarks/golden/v1/cases.json] [--timeout-min=22]
//     [--run-dir=<dir>]
// Credentials: OPENAI_API_KEY (required), OPENAI_BASE_URL (optional; bare host
// or .../v1 - Codex POSTs to <base_url>/responses), both strictly from the
// process environment. The key reaches Codex only via env_key -> child env,
// never a file.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  arg,
  buildMetrics,
  DEFAULT_ARM_DIR,
  DEFAULT_CASES_FILE,
  detectOverClaim,
  finishRun,
  loadCase,
  makeRunDir,
  RESULTS_DIR,
  runOracle,
} from "./lib.mjs";

const CODEX_HOME_DIR = path.join(RESULTS_DIR, ".codex-home");

const caseId = arg("case", "GOLD-T0-BOX");
const timeoutMin = Number(arg("timeout-min", process.env.CHAMFER_BENCH_TIMEOUT_MIN || "22"));
const model = arg("model", process.env.CHAMFER_BENCH_CODEX_MODEL || "gpt-5.6-luna");
const reasoning = arg("reasoning", "high"); // minimal|low|medium|high
const armDir = path.resolve(arg("arm-dir", DEFAULT_ARM_DIR));
const casesFile = path.resolve(arg("cases-file", DEFAULT_CASES_FILE));

if (!(process.env.OPENAI_API_KEY || "").trim()) {
  console.error(
    [
      "Missing credentials: OPENAI_API_KEY is not set in the environment.",
      "The codex arm reads credentials from process env only (never from files).",
      "Export OPENAI_API_KEY (and optionally OPENAI_BASE_URL for a gateway) and re-run.",
    ].join("\n"),
  );
  process.exit(1);
}

const kase = loadCase(casesFile, caseId);

const runDirArg = arg("run-dir", "");
const runDir = runDirArg ? path.resolve(runDirArg) : makeRunDir("codex", caseId);
fs.mkdirSync(runDir, { recursive: true });
const exportPath = path.join(runDir, "design.step");
const casePrompt = kase.prompt.replaceAll("{EXPORT_PATH}", exportPath);
// codex exec has no --append-system-prompt; prepend the arm system prompt.
const systemPrompt = fs.readFileSync(path.join(armDir, "system-prompt.txt"), "utf8");
const fullPrompt = `${systemPrompt.trim()}\n\n# Task\n${casePrompt}`;

// b123 server command shared with the other arms via the arm's mcp.json.
const armMcp = JSON.parse(fs.readFileSync(path.join(armDir, "mcp.json"), "utf8"));
const b123 = armMcp.mcpServers?.b123;
if (!b123?.command) {
  console.error(`arm mcp.json at ${armDir} has no mcpServers.b123.command`);
  process.exit(1);
}

// Dedicated CODEX_HOME, config regenerated every invocation so a stale private
// base URL never lingers. No secret is written: env_key defers to the child env.
fs.mkdirSync(CODEX_HOME_DIR, { recursive: true });
const baseUrlRaw = (process.env.OPENAI_BASE_URL || "").trim().replace(/\/+$/, "");
const codexBaseUrl = baseUrlRaw ? (baseUrlRaw.endsWith("/v1") ? baseUrlRaw : `${baseUrlRaw}/v1`) : "";
const providerBlock = codexBaseUrl
  ? `model_provider = "gateway"

[model_providers.gateway]
name = "Benchmark gateway"
base_url = "${codexBaseUrl}"
env_key = "OPENAI_API_KEY"
wire_api = "responses"
`
  : "";
const codexConfig = `# Generated at runtime by codexRun.mjs - isolated CODEX_HOME (NOT ~/.codex). Never commit.
model = "${model}"
model_reasoning_effort = "${reasoning}"
${providerBlock}
# Same b123 stdio MCP server as the pi and claude arms (from the arm's mcp.json).
[mcp_servers.b123]
command = ${JSON.stringify(b123.command)}
args = ${JSON.stringify(b123.args || [])}
startup_timeout_sec = 60
tool_timeout_sec = 600
`;
fs.writeFileSync(path.join(CODEX_HOME_DIR, "config.toml"), codexConfig);

// Parse the `codex exec --json` JSONL event stream. Events: thread.started,
// turn.started, item.completed (item.type: agent_message | reasoning |
// command_execution | mcp_tool_call | ...), turn.completed (usage), error.
function parseCodexEvents(stdout, proc) {
  const NON_TOOL = new Set(["agent_message", "reasoning", "todo_list", "error"]);
  const out = {
    threadId: null,
    turns: 0,
    // NOTE: codex input_tokens are cache-INCLUSIVE (cached_input_tokens is the
    // cached subset of input_tokens, not an extra bucket). No cacheWrite figure.
    usage: { input: 0, cachedInput: 0, output: 0, reasoningOutput: 0 },
    itemsByType: {},
    toolCalls: 0,
    b123Calls: 0,
    executeCalls: 0,
    errorMessages: [],
    finalTexts: [],
  };
  for (const line of (stdout || "").split("\n")) {
    const s = line.trim();
    if (!s) continue;
    let o;
    try {
      o = JSON.parse(s);
    } catch {
      continue;
    }
    switch (o.type) {
      case "thread.started":
        out.threadId = o.thread_id ?? out.threadId;
        break;
      case "turn.completed": {
        out.turns += 1;
        const u = o.usage || {};
        out.usage.input += u.input_tokens || 0;
        out.usage.cachedInput += u.cached_input_tokens || 0;
        out.usage.output += u.output_tokens || 0;
        out.usage.reasoningOutput += u.reasoning_output_tokens || 0;
        break;
      }
      case "item.completed": {
        const it = o.item || {};
        const t = it.type || "unknown";
        out.itemsByType[t] = (out.itemsByType[t] || 0) + 1;
        if (t === "agent_message" && it.text) out.finalTexts.push(it.text);
        if (t === "error") out.errorMessages.push(JSON.stringify(it).slice(0, 300));
        if (!NON_TOOL.has(t)) {
          out.toolCalls += 1;
          if (t === "mcp_tool_call") {
            const server = it.server ?? it.server_name ?? "";
            const tool = it.tool ?? it.tool_name ?? "";
            if (server === "b123" || JSON.stringify(it).includes('"b123"')) out.b123Calls += 1;
            if (tool === "execute") out.executeCalls += 1;
          }
        }
        break;
      }
      case "error":
        out.errorMessages.push(JSON.stringify(o).slice(0, 300));
        break;
      default:
        break;
    }
  }
  out.cappedByTimeout = !!(proc.error && String(proc.error).includes("ETIMEDOUT"));
  return out;
}

// Rollout/session log: cumulative token usage + latency figures (richer than
// the event stream). Path: $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<threadId>.jsonl
function readRollout(codexHome, threadId) {
  const root = path.join(codexHome, "sessions");
  let file = null;
  const walk = (d) => {
    if (file || !fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (file) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(`${threadId}.jsonl`)) file = p;
    }
  };
  walk(root);
  if (!file) return null;
  const out = { totalTokenUsage: null, modelContextWindow: null, durationMs: null, timeToFirstTokenMs: null };
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const s = line.trim();
    if (!s) continue;
    let o;
    try {
      o = JSON.parse(s);
    } catch {
      continue;
    }
    const pl = o.payload;
    if (o.type === "event_msg" && pl?.type === "token_count") {
      out.totalTokenUsage = pl.info?.total_token_usage ?? out.totalTokenUsage;
      out.modelContextWindow = pl.info?.model_context_window ?? out.modelContextWindow;
    } else if (o.type === "event_msg" && pl?.type === "task_complete") {
      out.durationMs = pl.duration_ms ?? out.durationMs;
      out.timeToFirstTokenMs = pl.time_to_first_token_ms ?? out.timeToFirstTokenMs;
    }
  }
  return out;
}

const lastMsgFile = path.join(runDir, "codex-last-message.txt");
const args = [
  "exec",
  "--model",
  model,
  "--dangerously-bypass-approvals-and-sandbox", // headless; MCP calls must not block on approval
  "--skip-git-repo-check", // runDir is scratch, non-git
  "-C",
  runDir, // working root = run dir so the b123 export sandbox allows design.step
  "--json",
  "-o",
  lastMsgFile,
  fullPrompt,
];
// Scrub inherited OPENAI_/CODEX_ vars, then inject exactly what codex needs.
const childEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !/^(OPENAI_|CODEX_)/.test(k)),
);
childEnv.CODEX_HOME = CODEX_HOME_DIR;
childEnv.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (baseUrlRaw) childEnv.OPENAI_BASE_URL = baseUrlRaw; // echo only; config.toml base_url is authoritative

const t0 = Date.now();
const proc = spawnSync("codex", args, {
  cwd: runDir,
  // CRITICAL: stdin must be closed ("ignore"). An open non-TTY stdin pipe makes
  // `codex exec` block on "Reading additional input from stdin..." forever.
  stdio: ["ignore", "pipe", "pipe"],
  env: childEnv,
  encoding: "utf8",
  maxBuffer: 256 * 1024 * 1024,
  timeout: timeoutMin * 60 * 1000,
});
const wallMs = Date.now() - t0;

const agentOut = parseCodexEvents(proc.stdout, proc);
const rollout = agentOut.threadId ? readRollout(CODEX_HOME_DIR, agentOut.threadId) : null;
const lastMessage = fs.existsSync(lastMsgFile) ? fs.readFileSync(lastMsgFile, "utf8").trim() : null;
const finalText = lastMessage || agentOut.finalTexts.slice(-1)[0] || null;

const grade = runOracle(exportPath, caseId, casesFile, kase.checks.length);
const overClaim = detectOverClaim(finalText, grade);
const metrics = buildMetrics({
  grade,
  overClaim,
  // Cost only if the events carried it - they do not for a custom gateway.
  costUsd: null,
  tokens: {
    in: agentOut.usage.input, // cache-INCLUSIVE (see parse note)
    out: agentOut.usage.output,
    cacheRead: agentOut.usage.cachedInput,
    cacheWrite: 0, // not reported by codex
  },
  toolCallsTotal: agentOut.toolCalls,
  executes: agentOut.executeCalls,
  wallMs,
});
metrics.costNote = "n/a (gateway has no pricing)";
metrics.tokensNote = "tokens.in is cache-inclusive; cacheRead is the cached subset of it; cacheWrite not reported";

const record = {
  case: caseId,
  agent: "codex",
  model,
  modelFamily: "openai-responses",
  modelFamilyNote: "codex speaks the OpenAI Responses wire API only; it cannot run Anthropic/Claude models",
  reasoning,
  wallMs,
  exportPath,
  exported: fs.existsSync(exportPath),
  grade,
  metrics,
  agentOut: {
    completed: proc.status === 0 && !agentOut.cappedByTimeout,
    cappedByTimeout: agentOut.cappedByTimeout,
    exitStatus: proc.status,
    spawnError: proc.error ? String(proc.error) : null,
    threadId: agentOut.threadId,
    // codex exec is one agent turn; the tool loop happens inside it. Use
    // toolCalls, not turns, as the effort measure.
    turns: agentOut.turns,
    turnsNote: "codex exec = one agent turn; internal tool loop is not turn-counted",
    usage: agentOut.usage,
    itemsByType: agentOut.itemsByType,
    toolCalls: agentOut.toolCalls,
    b123Calls: agentOut.b123Calls,
    executeCalls: agentOut.executeCalls,
    errorMessages: agentOut.errorMessages,
    result: finalText,
    rollout,
    stderrTail: (proc.stderr || "").slice(-2000),
  },
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
        completed: record.agentOut.completed,
        cappedByTimeout: agentOut.cappedByTimeout,
        exitStatus: proc.status,
        toolCalls: agentOut.toolCalls,
        b123Calls: agentOut.b123Calls,
        executeCalls: agentOut.executeCalls,
        tokens: metrics.tokens,
        errorMessages: agentOut.errorMessages.slice(0, 3),
        result: (finalText || "").slice(0, 300),
      },
    },
    null,
    2,
  ),
);
process.exit(0);
