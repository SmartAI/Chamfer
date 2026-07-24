#!/usr/bin/env node
/** Integration probe for the container-facing LLM proxy (issues #48/#53).
 *
 * Boots a hermetic `wrangler dev` (temp config, temp state, no .dev.vars) on a
 * private port against a fake upstream, then acts as the agent container:
 * mints a conversation token and completes a streamed /v1/messages request
 * through /api/llm/anthropic/<conversationId>/. Asserts:
 * - the upstream saw the resolved demo key, never the container token;
 * - the SSE body streamed back incrementally (first chunk before upstream
 *   finished) and byte-identical;
 * - no auth material echoed in the response headers;
 * - bad and cross-conversation tokens get 401.
 *
 * Then the #53 provider generalization, against BYOK settings stored through
 * the real session surface (dev login): openai and google requests take their
 * provider's path shape and auth header, a query-param credential is
 * stripped, and a provider without a Settings key is refused with a message
 * naming the missing key.
 *
 * Ports are probe-private (override: PROBE_PORT / UPSTREAM_PORT /
 * INSPECTOR_PORT). A busy port aborts the run - it may belong to a live
 * sibling session, so this script never kills existing listeners.
 *
 * Run from packages/online: `npm run probe:llm-proxy`.
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SignJWT } from "jose";

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROBE_PORT = Number(process.env.PROBE_PORT ?? 8790);
const UPSTREAM_PORT = Number(process.env.UPSTREAM_PORT ?? 8791);
const INSPECTOR_PORT = Number(process.env.INSPECTOR_PORT ?? 8792);
const TOKEN_SECRET = "probe-token-secret";
const DEMO_KEY = "probe-demo-key";
const CONVERSATION_ID = "probe-conv";

const failures = [];
function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name);
    console.error(`  FAIL ${name}${detail ? ` (${detail})` : ""}`);
  }
}

/** Same JWT shape mintLlmToken in src/llmToken.ts produces: HS256 via jose,
 * sub = user id, cnv = conversation id. */
async function mintToken(secret, userId, conversationId, ttlSeconds = 900) {
  return await new SignJWT({ cnv: conversationId })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttlSeconds)
    .sign(new TextEncoder().encode(secret));
}

function assertPortFree(port, label) {
  return new Promise((resolvePort, rejectPort) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      rejectPort(
        new Error(
          `${label} port ${port} is already in use - it may belong to a live session, so this probe `
            + `will not touch it. Re-run with ${label.toUpperCase()}_PORT=<free port>.`,
        ),
      );
    });
    socket.once("error", () => resolvePort());
  });
}

const SSE_CHUNKS = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg-probe","usage":{"input_tokens":42,"output_tokens":1}}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"probe"}}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
];

function startFakeUpstream() {
  const seen = [];
  let endedAt = 0;
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      seen.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
      let i = 0;
      const tick = setInterval(() => {
        if (i < SSE_CHUNKS.length) {
          res.write(SSE_CHUNKS[i++]);
        } else {
          clearInterval(tick);
          endedAt = Date.now();
          res.end();
        }
      }, 120);
    });
  });
  return new Promise((resolveServer) => {
    server.listen(UPSTREAM_PORT, "127.0.0.1", () =>
      resolveServer({ server, seen, upstreamEndedAt: () => endedAt }),
    );
  });
}

function writeProbeConfig(tempDir) {
  const config = {
    name: "chamfer-online-llm-proxy-probe",
    main: join(PACKAGE_DIR, "src/worker.ts"),
    compatibility_date: "2026-07-01",
    compatibility_flags: ["nodejs_compat"],
    durable_objects: {
      bindings: [{ name: "USER_DO", class_name: "ChamferUserDurableObject" }],
    },
    migrations: [{ tag: "v1", new_sqlite_classes: ["ChamferUserDurableObject"] }],
    r2_buckets: [{ binding: "ATTACHMENTS", bucket_name: "probe-attachments" }],
    assets: {
      directory: join(PACKAGE_DIR, "client-dist"),
      binding: "ASSETS",
      not_found_handling: "single-page-application",
      run_worker_first: ["/api/*"],
    },
    vars: {
      CHAMFER_LLM_TOKEN_SECRET: TOKEN_SECRET,
      CHAMFER_DEMO_ANTHROPIC_KEY: DEMO_KEY,
      CHAMFER_DEMO_ANTHROPIC_BASE_URL: `http://127.0.0.1:${UPSTREAM_PORT}`,
      // The multi-provider checks store BYOK settings through the real
      // session surface; dev login authenticates plain fetch as "dev-user".
      CHAMFER_DEV_LOGIN: "1",
    },
  };
  const configPath = join(tempDir, "wrangler.probe.json");
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  return configPath;
}

function startWrangler(configPath, tempDir) {
  const child = spawn(
    "npx",
    [
      "wrangler",
      "dev",
      "--config",
      configPath,
      "--port",
      String(PROBE_PORT),
      "--inspector-port",
      String(INSPECTOR_PORT),
      "--persist-to",
      join(tempDir, "state"),
    ],
    { cwd: PACKAGE_DIR, detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  let log = "";
  child.stdout.on("data", (data) => (log += data));
  child.stderr.on("data", (data) => (log += data));
  return { child, getLog: () => log };
}

async function waitForReady(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${PROBE_PORT}/api/online/config`);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("wrangler dev did not become ready in time");
}

async function main() {
  if (!existsSync(join(PACKAGE_DIR, "client-dist"))) {
    throw new Error("client-dist/ missing - run `npm run build:client` in packages/online first");
  }
  await assertPortFree(PROBE_PORT, "probe");
  await assertPortFree(UPSTREAM_PORT, "upstream");
  await assertPortFree(INSPECTOR_PORT, "inspector");

  const tempDir = mkdtempSync(join(tmpdir(), "chamfer-llm-proxy-probe-"));
  const { server, seen, upstreamEndedAt } = await startFakeUpstream();
  const { child, getLog } = startWrangler(writeProbeConfig(tempDir), tempDir);

  const cleanup = () => {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // already gone
    }
    server.close();
    rmSync(tempDir, { recursive: true, force: true });
  };
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });

  try {
    console.log(`starting wrangler dev on 127.0.0.1:${PROBE_PORT} (fake upstream on :${UPSTREAM_PORT})...`);
    await waitForReady();

    const token = await mintToken(TOKEN_SECRET, "probe-user", CONVERSATION_ID);
    const base = `http://127.0.0.1:${PROBE_PORT}/api/llm/anthropic`;
    const requestBody = JSON.stringify({ model: "claude-sonnet-5", stream: true, max_tokens: 32 });

    console.log("streamed completion through the proxy:");
    const response = await fetch(`${base}/${CONVERSATION_ID}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": token,
        "anthropic-version": "2023-06-01",
      },
      body: requestBody,
    });
    check("proxy answers 200", response.status === 200, `got ${response.status}`);
    check(
      "content-type is SSE",
      (response.headers.get("content-type") ?? "").includes("text/event-stream"),
    );

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let body = "";
    let reads = 0;
    let firstChunkAt = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      reads += 1;
      if (firstChunkAt === 0) firstChunkAt = Date.now();
      body += decoder.decode(value, { stream: true });
    }
    check("SSE body passed through byte-identical", body === SSE_CHUNKS.join(""));
    check("stream arrived in multiple chunks", reads >= 2, `${reads} reads`);
    check(
      "first chunk arrived before the upstream finished (incremental, not buffered)",
      firstChunkAt > 0 && firstChunkAt < upstreamEndedAt(),
      `first=${firstChunkAt} upstreamEnd=${upstreamEndedAt()}`,
    );

    check("upstream saw exactly one request", seen.length === 1);
    const upstreamRequest = seen[0] ?? { url: "", headers: {}, body: "" };
    check("upstream path is /v1/messages", upstreamRequest.url === "/v1/messages");
    check("upstream got the resolved demo key", upstreamRequest.headers["x-api-key"] === DEMO_KEY);
    check("upstream got no authorization header", upstreamRequest.headers.authorization === undefined);
    check(
      "container token never reached the upstream",
      !JSON.stringify(upstreamRequest.headers).includes(token),
    );
    check("request body forwarded intact", upstreamRequest.body === requestBody);
    const echoed = [...response.headers.entries()].map(([n, v]) => `${n}: ${v}`).join("\n");
    check("response echoes neither key nor token", !echoed.includes(DEMO_KEY) && !echoed.includes(token));

    console.log("rejections:");
    const badToken = await fetch(`${base}/${CONVERSATION_ID}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "e30.garbage.garbage" },
      body: requestBody,
    });
    check("garbled token gets 401", badToken.status === 401, `got ${badToken.status}`);

    const crossConversation = await fetch(`${base}/other-conv/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": token },
      body: requestBody,
    });
    check("cross-conversation token gets 401", crossConversation.status === 401, `got ${crossConversation.status}`);
    check("rejected requests never reached the upstream", seen.length === 1);

    console.log("multi-provider routes (#53):");
    // BYOK keys land in the dev-login user's DO through the real settings
    // route; their base URLs point back at the fake upstream, carrying the
    // version path exactly where the provider SDK convention puts it.
    const settingsPut = await fetch(`http://127.0.0.1:${PROBE_PORT}/api/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        openaiApiKey: "probe-openai-key",
        openaiBaseUrl: `http://127.0.0.1:${UPSTREAM_PORT}/v1`,
        googleApiKey: "probe-google-key",
        googleBaseUrl: `http://127.0.0.1:${UPSTREAM_PORT}/v1beta`,
      }),
    });
    check("BYOK settings stored via the session surface", settingsPut.ok, `got ${settingsPut.status}`);
    const devToken = await mintToken(TOKEN_SECRET, "dev-user", CONVERSATION_ID);
    const llmBase = `http://127.0.0.1:${PROBE_PORT}/api/llm`;

    const openaiResponse = await fetch(`${llmBase}/openai/${CONVERSATION_ID}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${devToken}` },
      body: JSON.stringify({ model: "gpt-test", input: [], stream: true }),
    });
    await openaiResponse.text();
    check("openai route answers 200", openaiResponse.status === 200, `got ${openaiResponse.status}`);
    const openaiSeen = seen.at(-1) ?? { url: "", headers: {} };
    check("openai upstream path is /v1/responses", openaiSeen.url === "/v1/responses", openaiSeen.url);
    check(
      "openai upstream got the user's key as a Bearer",
      openaiSeen.headers.authorization === "Bearer probe-openai-key",
      String(openaiSeen.headers.authorization),
    );
    check(
      "conversation token never reached the openai upstream",
      !JSON.stringify(openaiSeen.headers).includes(devToken),
    );

    const googleResponse = await fetch(
      `${llmBase}/google/${CONVERSATION_ID}/models/gemini-test:streamGenerateContent?alt=sse&key=smuggled`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": devToken },
        body: JSON.stringify({ contents: [] }),
      },
    );
    await googleResponse.text();
    check("google route answers 200", googleResponse.status === 200, `got ${googleResponse.status}`);
    const googleSeen = seen.at(-1) ?? { url: "", headers: {} };
    check(
      "google upstream path is /v1beta/models/... with the query-param key stripped",
      googleSeen.url === "/v1beta/models/gemini-test:streamGenerateContent?alt=sse",
      googleSeen.url,
    );
    check(
      "google upstream got the user's key as x-goog-api-key",
      googleSeen.headers["x-goog-api-key"] === "probe-google-key",
      String(googleSeen.headers["x-goog-api-key"]),
    );
    check(
      "conversation token never reached the google upstream",
      !JSON.stringify(googleSeen.headers).includes(devToken),
    );

    // A user with no key for the provider (the demo-funded "probe-user" DO
    // has none): the refusal names the missing key and never goes upstream.
    const upstreamCalls = seen.length;
    const refused = await fetch(`${llmBase}/google/${CONVERSATION_ID}/models/gemini-test:streamGenerateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": token },
      body: JSON.stringify({ contents: [] }),
    });
    check("keyless provider request gets 403", refused.status === 403, `got ${refused.status}`);
    const refusedBody = await refused.json().catch(() => ({}));
    check(
      "the refusal names the missing Google key and Settings",
      String(refusedBody?.error?.message ?? "").includes("Google API key")
        && String(refusedBody?.error?.message ?? "").includes("Settings"),
      JSON.stringify(refusedBody),
    );
    check("the refusal never reached the upstream", seen.length === upstreamCalls);

    if (failures.length > 0) {
      console.error(`\nPROBE FAILED: ${failures.length} assertion(s):\n- ${failures.join("\n- ")}`);
      console.error("\n--- wrangler dev log tail ---\n" + getLog().split("\n").slice(-30).join("\n"));
      process.exitCode = 1;
    } else {
      console.log("\nPROBE PASSED");
    }
  } finally {
    cleanup();
  }
}

main().catch((error) => {
  console.error(`\nPROBE ERROR: ${error.message}`);
  process.exit(1);
});
