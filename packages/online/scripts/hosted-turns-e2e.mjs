#!/usr/bin/env node
/** Online e2e for hosted agent turns (issue #51) - the increment-3b merge gate.
 *
 * Boots a hermetic `wrangler dev` (temp config, temp state, no .dev.vars) with
 * the per-user agent container against a fake Anthropic upstream behind the
 * demo key, then drives a real browser through the trial funnel: sign in (dev
 * login), create a conversation, prompt, watch live SSE, see the artifact in
 * the viewer. Afterwards it asserts the statelessness rule from the outside:
 * transcript rows in the user DO's store, the artifact object in local R2 -
 * then docker-kills the run's own container, prompts a follow-up, and proves
 * the fresh container reseeded with full context (the amnesia test). Records
 * first-turn latency (prompt -> artifact visible), the trial-funnel number.
 *
 * A sibling no-demo-key stack (issue #53) then reproduces the first live
 * incident's funding hole: a Google-model user with no Google key gets a
 * gated composer naming the missing key, and an API-driven turn's refusal
 * renders visibly in the transcript instead of an empty bubble plus "Done".
 *
 * Requirements: local Docker running (skips cleanly with exit 0 otherwise) and
 * a Playwright Chromium (any Playwright >= 1.55 install provides one).
 *
 * Ports are private to this script (override: E2E_PORT / UPSTREAM_PORT /
 * INSPECTOR_PORT). A busy port aborts the run - it may belong to a live
 * sibling session, so this script never kills existing listeners, and its
 * docker cleanup matches only containers created for its own worker name.
 *
 * Run from packages/online: `npm run e2e:hosted-turns`.
 */

import { execFileSync, spawn } from "node:child_process";
import { createConnection } from "node:net";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { startFakeAnthropic } from "../container/fakeAnthropic.mjs";

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKER_NAME = "chamfer-online-hosted-turns-e2e";
const WORKER_PORT = Number(process.env.E2E_PORT ?? 8794);
const UPSTREAM_PORT = Number(process.env.UPSTREAM_PORT ?? 8795);
const INSPECTOR_PORT = Number(process.env.INSPECTOR_PORT ?? 8796);
// The no-demo-key sibling stack (issue #53 defect 1): same image, no funding.
const NOKEY_WORKER_PORT = WORKER_PORT + 3;
const NOKEY_INSPECTOR_PORT = WORKER_PORT + 4;
const BASE = `http://127.0.0.1:${WORKER_PORT}`;
const NOKEY_BASE = `http://127.0.0.1:${NOKEY_WORKER_PORT}`;
// Dummy run-local credentials: the token secret only signs this run's JWTs,
// and the "demo key" only has to reach the fake upstream to be asserted on.
const TOKEN_SECRET = "e2e-hosted-turns-token-secret";
const DEMO_KEY = "e2e-dummy-demo-key";

const results = [];
const failures = [];
function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  ok   ${name}`);
    results.push(name);
  } else {
    failures.push(name);
    console.error(`  FAIL ${name}${detail ? ` (${detail})` : ""}`);
  }
}

function assertPortFree(port, label) {
  return new Promise((resolvePort, rejectPort) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      rejectPort(new Error(
        `${label} port ${port} is already in use - it may belong to a live session, so this script `
          + `will not touch it. Re-run with ${label.toUpperCase()}_PORT=<free port>.`,
      ));
    });
    socket.once("error", () => resolvePort());
  });
}

function docker(args) {
  return execFileSync("docker", args, { encoding: "utf8" });
}

/** Containers wrangler created for THIS run's worker, identified by the
 * run-unique worker name in the docker container name. The agent container
 * comes with a proxy-everything sidecar named "<container>-proxy": the
 * amnesia kill targets the agent container only, the final cleanup takes both.
 * Never a blanket kill - sibling sessions may run their own stacks. */
function runContainers({ includeProxy = false } = {}) {
  return docker(["ps", "--format", "{{.Names}}"])
    .trim()
    .split("\n")
    .filter((name) => name.includes(WORKER_NAME))
    .filter((name) => includeProxy || !name.endsWith("-proxy"));
}

async function waitFor(name, predicate, timeoutMs, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate().catch(() => undefined);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${name}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function writeE2eConfig(tempDir, variant = {}) {
  const config = {
    name: variant.name ?? WORKER_NAME,
    main: join(PACKAGE_DIR, "src/worker.ts"),
    compatibility_date: "2026-07-01",
    compatibility_flags: ["nodejs_compat"],
    durable_objects: {
      bindings: [
        { name: "USER_DO", class_name: "ChamferUserDurableObject" },
        { name: "AGENT_CONTAINER", class_name: "ChamferAgentContainer" },
      ],
    },
    migrations: [
      { tag: "v1", new_sqlite_classes: ["ChamferUserDurableObject"] },
      { tag: "v2", new_sqlite_classes: ["ChamferAgentContainer"] },
    ],
    containers: [
      {
        class_name: "ChamferAgentContainer",
        image: join(PACKAGE_DIR, "container/Dockerfile"),
        instance_type: "standard-1",
        max_instances: 2,
      },
    ],
    r2_buckets: [{ binding: "ATTACHMENTS", bucket_name: "e2e-attachments" }],
    assets: {
      directory: join(PACKAGE_DIR, "client-dist"),
      binding: "ASSETS",
      not_found_handling: "single-page-application",
      run_worker_first: ["/api/*"],
    },
    vars: {
      CHAMFER_DEV_LOGIN: "1",
      CHAMFER_LLM_TOKEN_SECRET: TOKEN_SECRET,
      // The no-key variant has no demo funding at all: a keyless turn must
      // surface the proxy's refusal in the transcript, not run on a demo key.
      ...(variant.demoKey === false ? {} : {
        CHAMFER_DEMO_ANTHROPIC_KEY: DEMO_KEY,
        CHAMFER_DEMO_ANTHROPIC_BASE_URL: `http://127.0.0.1:${UPSTREAM_PORT}`,
      }),
      // The container dials the Worker through the Docker host gateway;
      // wrangler dev's localhost is the container itself.
      CHAMFER_CONTAINER_LLM_ORIGIN: `http://host.docker.internal:${variant.workerPort ?? WORKER_PORT}`,
    },
  };
  const configPath = join(tempDir, variant.configFile ?? "wrangler.e2e.json");
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  return configPath;
}

// --- Preflight ---------------------------------------------------------------
try {
  docker(["version", "--format", "{{.Server.Version}}"]);
} catch {
  console.log("=".repeat(72));
  console.log("E2E SKIPPED: Docker is not available (daemon not running or CLI missing).");
  console.log("Install/start Docker and re-run: npm run e2e:hosted-turns");
  console.log("=".repeat(72));
  process.exit(0);
}
await assertPortFree(WORKER_PORT, "e2e");
await assertPortFree(UPSTREAM_PORT, "upstream");
await assertPortFree(INSPECTOR_PORT, "inspector");
await assertPortFree(NOKEY_WORKER_PORT, "e2e_nokey");
await assertPortFree(NOKEY_INSPECTOR_PORT, "nokey_inspector");

console.log("staging container build context (build.mjs)...");
execFileSync(process.execPath, [join(PACKAGE_DIR, "container/build.mjs")], { stdio: "inherit" });
if (!existsSync(join(PACKAGE_DIR, "client-dist"))) {
  console.log("client-dist/ missing; building the online client...");
  execFileSync("npm", ["run", "build:client"], { cwd: PACKAGE_DIR, stdio: "inherit" });
}

const tempDir = mkdtempSync(join(tmpdir(), "chamfer-hosted-turns-e2e-"));
const stub = await startFakeAnthropic(UPSTREAM_PORT);
console.log(`fake Anthropic upstream on :${UPSTREAM_PORT}`);

const wrangler = spawn(
  "npx",
  [
    "wrangler", "dev",
    "--config", writeE2eConfig(tempDir),
    "--port", String(WORKER_PORT),
    "--inspector-port", String(INSPECTOR_PORT),
    "--persist-to", join(tempDir, "state"),
  ],
  { cwd: PACKAGE_DIR, detached: true, stdio: ["ignore", "pipe", "pipe"] },
);
let wranglerLog = "";
wrangler.stdout.on("data", (data) => (wranglerLog += data));
wrangler.stderr.on("data", (data) => (wranglerLog += data));

let browser;
let nokeyWrangler;
let nokeyWranglerLog = "";
try {
  console.log("waiting for wrangler dev (first boot docker-builds the image; warm caches take seconds)...");
  await waitFor("worker readiness", async () => (await fetch(`${BASE}/api/online/config`)).ok, 10 * 60_000, 1000);

  const caps = await (await fetch(`${BASE}/api/runtime/capabilities`)).json();
  check("capabilities report agentHosting: true", caps.agentHosting === true, JSON.stringify(caps));
  check("capabilities advertise the demo quota and its pinned model", caps.demoQuota === true
    && typeof caps.demoModel?.id === "string" && typeof caps.demoModel?.name === "string", JSON.stringify(caps));
  const health = await (await fetch(`${BASE}/api/online/health`)).json();
  check("health lists no degraded capabilities", Array.isArray(health.degraded) && health.degraded.length === 0,
    JSON.stringify(health));

  // --- Browser session -------------------------------------------------------
  try {
    browser = await chromium.launch();
  } catch (error) {
    throw new Error(
      "playwright-core could not launch Chromium - install one with any Playwright toolchain "
        + `(e.g. \`npx playwright install chromium\`): ${error?.message ?? error}`,
    );
  }
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  const badResponses = [];
  page.on("response", (response) => {
    if (response.status() >= 400) badResponses.push(`${response.status()} ${response.request().method()} ${response.url()}`);
  });
  await page.goto(BASE, { waitUntil: "networkidle" });

  // New chat opens the CAD-environment dialog with build123d preselected.
  await page.getByRole("button", { name: "New chat" }).click();
  await page.getByRole("button", { name: "Start conversation" }).click();
  const composer = page.getByTestId("composer-input");
  await composer.waitFor({ state: "visible", timeout: 15_000 });
  check("composer is enabled (no degraded notice)", await composer.isEnabled());

  await composer.fill("Build a 10x20x30 box.");
  const artifactResponse = page.waitForResponse(
    (response) => response.url().includes("/artifact") && response.status() === 200,
    { timeout: 8 * 60_000 },
  );
  const t0 = Date.now();
  await page.getByTestId("composer-send").click();

  // Live SSE activity shows up mid-turn, well before the turn completes.
  await page.waitForSelector(
    '[data-testid="running-tool"], [data-testid="streaming-cursor"], [data-testid="generation-status"]',
    { timeout: 120_000 },
  );
  const liveAt = Date.now();
  check("live SSE activity visible in the browser", true);

  const artifact = await artifactResponse;
  const artifactAt = Date.now();
  check("viewer fetched the artifact (HTTP 200)", true);
  const revision1 = Number((await artifact.allHeaders())["x-artifact-revision"] ?? "0");
  check("artifact carries an R2 revision", revision1 >= 1, String(revision1));

  await page.waitForSelector("text=Done - built the 10x20x30 box", { timeout: 120_000 });
  const doneAt = Date.now();
  console.log(
    `first-turn latency: prompt -> live activity ${((liveAt - t0) / 1000).toFixed(1)}s, `
      + `prompt -> artifact visible ${((artifactAt - t0) / 1000).toFixed(1)}s, `
      + `prompt -> turn done ${((doneAt - t0) / 1000).toFixed(1)}s`,
  );

  const viewerCanvas = await page.locator('[data-testid="viewer"] canvas').count();
  check("viewer canvas rendered", viewerCanvas > 0, `canvas count ${viewerCanvas}`);

  // --- Store-of-record assertions (dev login authenticates plain fetch) ------
  const conversations = await (await fetch(`${BASE}/api/conversations`)).json();
  const conversationId = conversations[0]?.id;
  check("conversation exists in the DO store", Boolean(conversationId));

  const rows = await waitFor("turn-end transcript drain", async () => {
    const drained = await (await fetch(`${BASE}/api/conversations/${conversationId}/messages`)).json();
    const roles = new Set(drained.map((row) => row.role));
    return roles.has("user") && roles.has("assistant") && roles.has("toolResult") ? drained : undefined;
  }, 60_000, 1000);
  check("transcript rows drained into the DO store (user/assistant/toolResult)", true);
  check("executed CAD code is durably recorded",
    rows.some((row) => row.contentJson.includes("Box(width, depth, height)")));
  const turn1Rows = rows.length;

  const artifactCheck = await fetch(`${BASE}/api/agent/${conversationId}/artifact`);
  check("agent artifact route serves from R2", artifactCheck.status === 200, `status ${artifactCheck.status}`);
  const stlBytes = new Uint8Array(await artifactCheck.arrayBuffer());
  check("artifact bytes are non-empty STL", stlBytes.byteLength > 0, String(stlBytes.byteLength));

  const r2Files = execFileSync("find", [join(tempDir, "state"), "-path", "*r2*", "-type", "f"], { encoding: "utf8" })
    .trim().split("\n").filter(Boolean);
  check("artifact object persisted in local R2", r2Files.length > 0, `${r2Files.length} files`);

  const turn1Requests = stub.requests.length;
  check("turn 1 drove the fake upstream through the proxy (3 scripted calls)", turn1Requests === 3,
    String(turn1Requests));
  check("upstream saw the demo key, never a conversation token",
    stub.requests.every((request) => request.apiKey === DEMO_KEY),
    JSON.stringify(stub.requests.map((r) => r.apiKey)));

  // --- Amnesia test ----------------------------------------------------------
  const running = runContainers();
  check("exactly this run's agent container is running", running.length === 1, running.join(","));
  console.log(`docker kill ${running[0]} (the amnesia test)`);
  docker(["kill", running[0]]);

  await composer.fill("What did you build?");
  await page.getByTestId("composer-send").click();
  const followUp = await waitFor("follow-up LLM traffic", async () => {
    return stub.requests.length > turn1Requests ? stub.requests.slice(turn1Requests) : undefined;
  }, 5 * 60_000, 500);
  // The fake scripts by tool_result count across the whole transcript: step 2
  // is only reachable if the fresh container was reseeded with turn 1's two
  // tool results - a cold, amnesiac container would report step 0.
  check("fresh container reseeded with full context (fake upstream saw step 2)",
    followUp.some((request) => request.step === 2),
    JSON.stringify(followUp.map((r) => r.step)));

  const followUpRows = await waitFor("follow-up transcript drain", async () => {
    const drained = await (await fetch(`${BASE}/api/conversations/${conversationId}/messages`)).json();
    return drained.length > turn1Rows ? drained : undefined;
  }, 120_000, 1000);
  check("follow-up turn's rows drained into the DO store", followUpRows.length > turn1Rows,
    `${turn1Rows} -> ${followUpRows.length}`);

  // The only tolerated 4xx is the client's artifact probe on a conversation
  // that has no export yet - the transport treats that 404 as "no artifact"
  // (identical to the local deployment), but the browser still logs it.
  const unexpectedResponses = badResponses.filter((line) => !/404 GET .*\/artifact$/.test(line));
  check("no unexpected 4xx/5xx responses", unexpectedResponses.length === 0, unexpectedResponses.join(" ; "));
  const pageErrors = consoleErrors.filter((e) => !e.includes("favicon"));
  check("browser console errors match the tolerated artifact probe only",
    pageErrors.length <= badResponses.length - unexpectedResponses.length, pageErrors.join(" | "));

  // --- Sibling case (issue #53 defect 1): a refused turn surfaces a visible
  // error in the transcript, never an empty bubble plus "Done". A second
  // hermetic stack with NO demo key and a Google-model user with no Google
  // key reproduces the live incident's funding hole exactly.
  console.log("booting the no-demo-key sibling stack...");
  nokeyWrangler = spawn(
    "npx",
    [
      "wrangler", "dev",
      "--config", writeE2eConfig(tempDir, {
        name: `${WORKER_NAME}-nokey`,
        configFile: "wrangler.e2e-nokey.json",
        demoKey: false,
        workerPort: NOKEY_WORKER_PORT,
      }),
      "--port", String(NOKEY_WORKER_PORT),
      "--inspector-port", String(NOKEY_INSPECTOR_PORT),
      "--persist-to", join(tempDir, "state-nokey"),
    ],
    { cwd: PACKAGE_DIR, detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  nokeyWrangler.stdout.on("data", (data) => (nokeyWranglerLog += data));
  nokeyWrangler.stderr.on("data", (data) => (nokeyWranglerLog += data));
  await waitFor("no-key worker readiness", async () => (await fetch(`${NOKEY_BASE}/api/online/config`)).ok, 5 * 60_000, 1000);

  const nokeyCaps = await (await fetch(`${NOKEY_BASE}/api/runtime/capabilities`)).json();
  check("no-key stack hosts the agent but advertises no demo quota",
    nokeyCaps.agentHosting === true && nokeyCaps.demoQuota === false, JSON.stringify(nokeyCaps));

  // The user selects a Google model with no Google key configured.
  const models = await (await fetch(`${NOKEY_BASE}/api/models`)).json();
  const googleModel = models.find((model) => model.provider === "google");
  check("a google model is available to select", Boolean(googleModel), `models: ${models.length}`);
  const settingsPut = await fetch(`${NOKEY_BASE}/api/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    // ModelInfoDto.modelJson is the full serialized pi-ai model, exactly what
    // SettingsModal stores on selection.
    body: JSON.stringify({ modelJson: googleModel.modelJson }),
  });
  check("google model stored in Settings", settingsPut.ok, `status ${settingsPut.status}`);

  const nokeyPage = await browser.newPage();
  await nokeyPage.goto(NOKEY_BASE, { waitUntil: "networkidle" });
  await nokeyPage.getByRole("button", { name: "New chat" }).click();
  await nokeyPage.getByRole("button", { name: "Start conversation" }).click();
  const nokeyComposer = nokeyPage.getByTestId("composer-input");
  await nokeyComposer.waitFor({ state: "visible", timeout: 15_000 });
  // Defect 2 end to end: the unfunded provider gates the composer with a
  // hint naming the fix, instead of accepting a prompt that can only die.
  check("composer is disabled without a key for the selected provider", !(await nokeyComposer.isEnabled()));
  const hintVisible = await nokeyPage
    .getByText("Add your Google API key in Settings to run the selected model.")
    .isVisible()
    .catch(() => false);
  check("the composer hint names the missing Google key", hintVisible);

  // Defect 1 end to end: a turn can still be refused mid-flight (API caller,
  // revoked key, exhausted quota) - drive one through the API and require the
  // stored error to render in the transcript.
  const nokeyConversations = await (await fetch(`${NOKEY_BASE}/api/conversations`)).json();
  const nokeyConversationId = nokeyConversations[0]?.id;
  check("no-key conversation exists", Boolean(nokeyConversationId));
  const nokeyPrompt = await fetch(`${NOKEY_BASE}/api/agent/${nokeyConversationId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "Build a 10x20x30 box." }),
  });
  check("the prompt is accepted (the refusal happens inside the turn)", nokeyPrompt.status === 202,
    `status ${nokeyPrompt.status}`);

  const erroredRows = await waitFor("refused turn drained with a stored error", async () => {
    const rows = await (await fetch(`${NOKEY_BASE}/api/conversations/${nokeyConversationId}/messages`)).json();
    const errored = rows.filter((row) => row.role === "assistant" && row.contentJson.includes('"error"'));
    return errored.length > 0 ? errored : undefined;
  }, 4 * 60_000, 1000);
  check("the stored assistant row names the missing Google key",
    erroredRows.some((row) => row.contentJson.includes("Google API key")),
    erroredRows.map((row) => row.contentJson.slice(0, 200)).join(" | "));

  // Reload: the persisted transcript must render the error visibly. Not
  // networkidle - the live agent events stream keeps the network busy forever.
  await nokeyPage.reload({ waitUntil: "domcontentloaded" });
  const errorNote = nokeyPage.getByTestId("assistant-error");
  await errorNote.first().waitFor({ state: "visible", timeout: 30_000 });
  const errorText = await errorNote.first().textContent();
  check("the transcript renders the turn error visibly", (errorText ?? "").includes("Google API key"),
    errorText ?? "");
  const doneVisible = await nokeyPage.getByTestId("generation-status").isVisible().catch(() => false);
  check("no green Done after an errored turn", !doneVisible);
  await nokeyPage.close();
} catch (error) {
  failures.push(String(error?.message ?? error));
  console.error("E2E ERROR:", error);
  console.error("--- wrangler log tail ---\n" + wranglerLog.split("\n").slice(-50).join("\n"));
  if (nokeyWranglerLog) {
    console.error("--- no-key wrangler log tail ---\n" + nokeyWranglerLog.split("\n").slice(-50).join("\n"));
  }
} finally {
  try { await browser?.close(); } catch { /* already closed */ }
  try { process.kill(-wrangler.pid, "SIGTERM"); } catch { /* already gone */ }
  if (nokeyWrangler) {
    try { process.kill(-nokeyWrangler.pid, "SIGTERM"); } catch { /* already gone */ }
  }
  await new Promise((r) => setTimeout(r, 3000));
  try { process.kill(-wrangler.pid, "SIGKILL"); } catch { /* already gone */ }
  if (nokeyWrangler) {
    try { process.kill(-nokeyWrangler.pid, "SIGKILL"); } catch { /* already gone */ }
  }
  for (const name of runContainers({ includeProxy: true })) {
    try {
      docker(["kill", name]);
      console.log(`killed leftover container ${name}`);
    } catch { /* already gone */ }
  }
  await stub.close();
  rmSync(tempDir, { recursive: true, force: true });
}

console.log("=".repeat(72));
if (failures.length > 0) {
  console.error(`E2E FAIL: ${failures.length} failure(s): ${failures.join("; ")}`);
  process.exit(1);
}
console.log(`E2E PASS: ${results.length} checks`);
