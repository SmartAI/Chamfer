import { join } from "node:path";
import { serve } from "@hono/node-server";
import { openDb } from "../db";
import { PiAgentSessions } from "../agent/piSession";
import { LocalArtifactStore } from "../agent/artifactStore";
import { createContainerApp } from "./app";
import {
  applyContainerLlmSettings,
  applyTurnLlmDelivery,
  resolveContainerLlmConfig,
  scrubProviderCredentials,
} from "./config";

/**
 * Boot entry for the hosted agent container (issue #47): only the agent slice
 * as an HTTP service on one port. No client, no dotenv walk - configuration
 * is the container environment, state is the scratch CHAMFER_DATA_DIR, and
 * the only LLM egress is the proxy configured through CHAMFER_LLM_BASE_URL.
 */

const scrubbed = scrubProviderCredentials(process.env);
if (scrubbed.length > 0) {
  console.warn(
    `container: scrubbed provider credentials from the environment (${scrubbed.join(", ")}); ` +
      "the container accepts no provider keys - LLM egress goes through CHAMFER_LLM_BASE_URL only",
  );
}

const llm = resolveContainerLlmConfig(process.env);
const dataDir = process.env.CHAMFER_DATA_DIR ?? "/data";
const port = process.env.PORT ? Number(process.env.PORT) : 8787;

const db = openDb(join(dataDir, "chamfer.db"));
applyContainerLlmSettings(db, llm);
const artifactStore = new LocalArtifactStore(dataDir);
const sessions = new PiAgentSessions(db, dataDir, artifactStore);
const app = createContainerApp(db, sessions, artifactStore, {
  // Per-turn delivery (issues #51/#53): settings write first (session builds
  // read them), then a live-runtime refresh so an already-built session's
  // next LLM request rides the fresh token (pi resolves credentials per
  // request) and the delivered model (refreshCredentials switches a warm
  // session via pi's setModel when the delivery changes it).
  applyLlmDelivery: async (delivery) => {
    applyTurnLlmDelivery(db, delivery);
    await sessions.refreshCredentials();
  },
  // The image build identity (issue #56). build.mjs replaces this at bundle
  // time with the pinned wrangler.jsonc tag (esbuild define); an unbundled run
  // leaves it undefined and /api/health reports "unknown".
  imageVersion: process.env.CHAMFER_IMAGE_VERSION,
});

const server = serve({ fetch: app.fetch, hostname: "0.0.0.0", port }, (info) => {
  console.log(
    `chamfer agent container on http://0.0.0.0:${info.port} (model ${llm.modelId}, llm egress ${llm.baseUrl}, data ${dataDir})`,
  );
});

/** Container runtimes stop with SIGTERM; dispose sessions so in-flight MCP
 * subprocesses shut down instead of being orphaned into the kill. */
function shutdown(signal: string): void {
  console.log(`container: ${signal} received, shutting down`);
  void sessions.dispose().finally(() => {
    server.close();
    process.exit(0);
  });
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
