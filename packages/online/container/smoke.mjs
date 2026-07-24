// End-to-end smoke for the hosted agent container image (issue #47):
//   docker build -> docker run -> seed -> one agent turn over SSE ->
//   transcript rows + artifact.stl back out, with geometric verification of
//   the exported STL.
//
// Default mode needs no credentials anywhere: CHAMFER_FAKE_LLM=1 with the
// scripted Anthropic stub (fakeAnthropic.mjs) standing in for the increment-2b
// Worker proxy; the stub drives real build123d-mcp execute/export inside the
// image. --golden runs one real-LLM golden case (GOLD-T0-BOX) through the
// image instead, taking the API key from the repo's .env/.env.local strictly
// at script level and passing the provider endpoint as the proxy stand-in;
// the image itself still receives only CHAMFER_LLM_BASE_URL + token.
//
// Skips cleanly (exit 0, loud message) when Docker is unavailable.
//
// Usage:
//   node packages/online/container/smoke.mjs [--golden] [--skip-build] [--keep]
// Env:
//   CHAMFER_CONTAINER_PLATFORM  optional --platform for docker build/run
//                               (default: host-native so the smoke is not
//                               crippled by emulation; deployment is amd64)
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { startFakeAnthropic } from "./fakeAnthropic.mjs";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const repoRoot = here("../../..");
const args = new Set(process.argv.slice(2));
const golden = args.has("--golden");
const IMAGE = "chamfer-agent-container:smoke";
const CONTAINER = `chamfer-container-smoke-${process.pid}`;
const platform = process.env.CHAMFER_CONTAINER_PLATFORM;

function docker(dockerArgs, options = {}) {
  return execFileSync("docker", dockerArgs, { encoding: "utf8", ...options });
}

function fail(message) {
  console.error(`\nSMOKE FAIL: ${message}`);
  try {
    console.error("--- container logs ---");
    console.error(docker(["logs", CONTAINER]));
  } catch {
    // No container to report on.
  }
  process.exitCode = 1;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** Bounding box of an STL (binary or ascii), for geometric verification. */
function stlBoundingBox(bytes) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const take = (x, y, z) => {
    const v = [x, y, z];
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis], v[axis]);
      max[axis] = Math.max(max[axis], v[axis]);
    }
  };
  const head = new TextDecoder().decode(bytes.slice(0, 512));
  if (head.trimStart().startsWith("solid") && head.includes("facet")) {
    const text = new TextDecoder().decode(bytes);
    for (const match of text.matchAll(/vertex\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)/g)) {
      take(Number(match[1]), Number(match[2]), Number(match[3]));
    }
  } else {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const triangles = view.getUint32(80, true);
    for (let i = 0; i < triangles; i += 1) {
      const base = 84 + i * 50 + 12;
      for (let vertex = 0; vertex < 3; vertex += 1) {
        const offset = base + vertex * 12;
        take(view.getFloat32(offset, true), view.getFloat32(offset + 4, true), view.getFloat32(offset + 8, true));
      }
    }
  }
  return [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
}

/** Env value with the server's precedence: shell env > .env.local > .env. */
function repoEnv(name) {
  if (process.env[name]) return process.env[name];
  for (const file of [".env.local", ".env"]) {
    const path = `${repoRoot}/${file}`;
    if (!existsSync(path)) continue;
    const parsed = parseEnv(readFileSync(path, "utf8"));
    if (parsed[name]) return parsed[name];
  }
  return undefined;
}

function goldenPrompt() {
  const { cases } = JSON.parse(readFileSync(`${repoRoot}/benchmarks/golden/v1/cases.json`, "utf8"));
  const boxCase = cases.find((entry) => entry.id === "GOLD-T0-BOX");
  assert(boxCase, "GOLD-T0-BOX not found in benchmarks/golden/v1/cases.json");
  // The golden prompt ends with the bench's export-STEP-to-path contract; the
  // product's system prompt owns the ./artifact.stl export instead.
  const cut = boxCase.prompt.indexOf(" When the part is complete and verified, export");
  assert(cut > 0, "GOLD-T0-BOX prompt no longer carries the export contract sentence");
  return boxCase.prompt.slice(0, cut);
}

// --- Docker availability -----------------------------------------------------
try {
  docker(["version", "--format", "{{.Server.Version}}"], { stdio: ["ignore", "pipe", "pipe"] });
} catch {
  console.log("=".repeat(72));
  console.log("SMOKE SKIPPED: Docker is not available (daemon not running or CLI missing).");
  console.log("Install/start Docker and re-run: node packages/online/container/smoke.mjs");
  console.log("=".repeat(72));
  process.exit(0);
}

// --- Build -------------------------------------------------------------------
if (!args.has("--skip-build")) {
  console.log("staging build context (build.mjs)...");
  execFileSync(process.execPath, [here("./build.mjs")], { stdio: "inherit" });
  console.log(`docker build ${IMAGE}${platform ? ` (${platform})` : " (host-native)"}...`);
  const buildStart = Date.now();
  execFileSync(
    "docker",
    ["build", ...(platform ? ["--platform", platform] : []), "-t", IMAGE, here(".")],
    { stdio: "inherit" },
  );
  console.log(`docker build took ${((Date.now() - buildStart) / 1000).toFixed(0)}s`);
}
const imageBytes = Number(docker(["image", "inspect", IMAGE, "--format", "{{.Size}}"]).trim());
const imageMb = (imageBytes / 1024 / 1024).toFixed(0);
console.log(`image size: ${imageMb} MB (${imageBytes} bytes)`);

// --- Run one turn ------------------------------------------------------------
let stub;
let coldStartMs;
let healthMs;
try {
  const runEnv = [];
  let promptText;
  let turnTimeoutMs;
  if (golden) {
    // ------------------------------------------------------------------
    // KEY CUSTODY EXCEPTION - LOCAL DEVELOPMENT ONLY (#40, ADR 0003)
    //
    // This mode hands a real credential into the container as
    // CHAMFER_LLM_TOKEN, with a provider/gateway endpoint standing in for
    // the Worker proxy. That is a deliberate, authorized exception whose
    // sole purpose is the one local proof that the baked uv/build123d
    // environment executes real geometry (#47 evaluation gate). It must
    // NEVER run against the hosted deployment, and it is not how hosted
    // custody works: on the hosted deployment the container only ever
    // receives a short-lived conversation-scoped token, the increment-2b
    // Worker proxy (/api/llm/anthropic, #48) injects the real key at its
    // own choke point, and that property is proven by this script's fake
    // mode plus the #48 proxy test suite - not by this mode.
    // ------------------------------------------------------------------
    console.error(
      "WARNING: --golden is a local-dev custody exception: a real key enters the local container as the token. " +
        "Never run this against the hosted deployment.",
    );
    const apiKey = repoEnv("ANTHROPIC_API_KEY");
    const model = process.env.CHAMFER_GOLDEN_MODEL ?? repoEnv("CHAMFER_MODEL");
    // The local config's ANTHROPIC_BASE_URL (an LLM gateway, when present) is
    // the closest stand-in for the increment-2b Worker proxy; the provider's
    // own endpoint is the fallback. Key and URL stay strictly script-level.
    const proxyStandIn = repoEnv("ANTHROPIC_BASE_URL") ?? "https://api.anthropic.com";
    assert(apiKey, "--golden needs ANTHROPIC_API_KEY in the shell env or repo .env/.env.local");
    assert(model, "--golden needs CHAMFER_MODEL (or CHAMFER_GOLDEN_MODEL) configured");
    console.log(`golden mode: model ${model}, proxy stand-in ${proxyStandIn}`);
    runEnv.push(
      "-e", `CHAMFER_MODEL=${model}`,
      "-e", "CHAMFER_PROVIDER=anthropic",
      "-e", `CHAMFER_LLM_BASE_URL=${proxyStandIn}`,
      "-e", `CHAMFER_LLM_TOKEN=${apiKey}`,
    );
    promptText = goldenPrompt();
    turnTimeoutMs = 15 * 60_000;
  } else {
    stub = await startFakeAnthropic();
    console.log(`fake Anthropic stub on host port ${stub.port}`);
    runEnv.push(
      "-e", "CHAMFER_FAKE_LLM=1",
      "-e", "CHAMFER_MODEL=chamfer-fake",
      "-e", `CHAMFER_LLM_BASE_URL=http://host.docker.internal:${stub.port}`,
      "-e", "CHAMFER_LLM_TOKEN=smoke-token",
    );
    promptText = "Build a 10x20x30 box.";
    turnTimeoutMs = 5 * 60_000;
  }

  const runStart = Date.now();
  docker([
    "run", "-d", "--name", CONTAINER,
    ...(platform ? ["--platform", platform] : []),
    "--add-host", "host.docker.internal:host-gateway",
    "-p", "127.0.0.1:0:8787",
    ...runEnv,
    IMAGE,
  ]);
  const hostPort = docker(["port", CONTAINER, "8787/tcp"]).trim().split("\n")[0].split(":").pop();
  const base = `http://127.0.0.1:${hostPort}`;

  const healthDeadline = Date.now() + 60_000;
  for (;;) {
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) break;
    } catch {
      // Not up yet.
    }
    assert(Date.now() < healthDeadline, "container did not become healthy within 60s");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  healthMs = Date.now() - runStart;
  console.log(`health ready ${healthMs}ms after docker run`);

  const conversationId = crypto.randomUUID();
  const seed = await fetch(`${base}/api/container/${conversationId}/seed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cadEnvironment: "build123d", rows: [] }),
  });
  const seedText = await seed.text();
  assert(seed.ok, `seed failed: ${seed.status} ${seedText}`);
  const seedBody = JSON.parse(seedText);
  assert(seedBody.maxSeq === -1, "fresh container should start with an empty transcript");

  // SSE must be open before the prompt (no replay on this stream).
  const seenEvents = [];
  let firstEventAt;
  let resolveEnd;
  let rejectEnd;
  const turnEnd = new Promise((resolve, reject) => {
    resolveEnd = resolve;
    rejectEnd = reject;
  });
  const sse = await fetch(`${base}/api/agent/${conversationId}/events`);
  assert(sse.ok && sse.body, `events stream failed: ${sse.status}`);
  (async () => {
    const reader = sse.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
        if (!dataLine) continue;
        const event = JSON.parse(dataLine.slice(6));
        if (!event.type || event.type === "agent_status") continue;
        if (firstEventAt === undefined) firstEventAt = Date.now();
        seenEvents.push(event.type);
        if (event.type === "tool_execution_start") console.log(`  tool: ${event.toolName}`);
        if (event.type === "agent_error") rejectEnd(new Error(`agent_error: ${event.message}`));
        // agent_settled, not agent_end: pi emits agent_end per internal run and
        // continues the same turn on retry / overflow-compaction. Only settled
        // marks the whole prompt done.
        if (event.type === "agent_settled") resolveEnd();
      }
    }
  })().catch(() => {});

  const prompt = await fetch(`${base}/api/agent/${conversationId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: promptText }),
  });
  if (prompt.status !== 202) throw new Error(`prompt rejected: ${prompt.status} ${await prompt.text()}`);
  console.log("turn running...");

  const timeout = setTimeout(
    () => rejectEnd(new Error(`turn did not finish within ${turnTimeoutMs / 1000}s; events: ${seenEvents.join(",")}`)),
    turnTimeoutMs,
  );
  await turnEnd;
  clearTimeout(timeout);
  coldStartMs = firstEventAt - runStart;
  console.log(`turn complete; cold start (docker run -> first SSE agent event): ${coldStartMs}ms`);

  assert(seenEvents.includes("agent_start"), "no agent_start event on the stream");
  assert(seenEvents.includes("artifact_updated"), "no artifact_updated event: the turn produced no export");

  // The stateless seams: everything of record leaves the machine.
  const transcript = await fetch(`${base}/api/container/${conversationId}/transcript?afterSeq=-1`);
  assert(transcript.ok, `transcript fetch failed: ${transcript.status}`);
  const { rows, artifactRevision } = await transcript.json();
  const roles = rows.map((row) => row.role);
  assert(roles.includes("user") && roles.includes("assistant") && roles.includes("toolResult"),
    `transcript is missing roles: ${roles.join(",")}`);
  assert(typeof artifactRevision === "number", "transcript did not report an artifact revision");
  assert(rows.some((row) => row.contentJson.includes("artifact.stl")),
    "no transcript row records the artifact export tool call");
  if (!golden) {
    assert(rows.some((row) => row.contentJson.includes("Box(width, depth, height)")),
      "the executed CAD code is not durably recorded in the transcript");
  }

  const artifact = await fetch(`${base}/api/agent/${conversationId}/artifact`);
  assert(artifact.ok, `artifact fetch failed: ${artifact.status}`);
  assert(artifact.headers.get("content-type") === "model/stl", "artifact content-type is not model/stl");
  assert(Number(artifact.headers.get("x-artifact-revision")) === artifactRevision,
    "artifact revision header disagrees with the transcript seam");
  const bytes = new Uint8Array(await artifact.arrayBuffer());
  assert(bytes.byteLength > 0, "artifact.stl is empty");
  const [width, depth, height] = stlBoundingBox(bytes);
  const tolerance = 0.2;
  assert(
    Math.abs(width - 10) < tolerance && Math.abs(depth - 20) < tolerance && Math.abs(height - 30) < tolerance,
    `exported STL bounding box is ${width}x${depth}x${height}, expected 10x20x30`,
  );
  console.log(`artifact verified: ${bytes.byteLength} bytes, bbox ${width}x${depth}x${height} mm, revision ${artifactRevision}`);

  if (stub) {
    assert(stub.requests.length === 3, `stub expected 3 LLM calls, saw ${stub.requests.length}`);
    assert(stub.requests.every((request) => request.apiKey === "smoke-token"),
      "the conversation token did not reach the LLM egress as the bearer credential");
    assert(stub.requests[0].toolNames.includes("execute") && stub.requests[0].toolNames.includes("export"),
      `direct MCP tools missing from the LLM request: ${stub.requests[0].toolNames.join(",")}`);
  }

  console.log("=".repeat(72));
  console.log(`SMOKE PASS (${golden ? "golden real-LLM" : "fake-LLM"})`);
  console.log(`  image size:                        ${imageMb} MB`);
  console.log(`  cold start -> first SSE event:     ${(coldStartMs / 1000).toFixed(1)}s`);
  console.log(`  docker run -> health:              ${(healthMs / 1000).toFixed(1)}s`);
  console.log("=".repeat(72));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  if (!args.has("--keep")) {
    try {
      docker(["rm", "-f", CONTAINER], { stdio: "ignore" });
    } catch {
      // Never started.
    }
  } else {
    console.log(`container kept: ${CONTAINER}`);
  }
  if (stub) await stub.close();
}
