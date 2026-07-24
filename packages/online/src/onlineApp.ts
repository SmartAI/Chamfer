import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { settingsRoutes } from "../../server/src/routes/settings";
import { modelsRoutes } from "../../server/src/routes/models";
import { streamRoutes } from "../../server/src/routes/stream";
import { conversationsRoutes } from "../../server/src/routes/conversations";
import { artifactsRoutes } from "../../server/src/routes/artifacts";
import { imageDiagnosticsRoutes } from "../../server/src/routes/imageDiagnostics";
import { evidenceRoutes } from "../../server/src/routes/evidence";
import { durableNoteRoutes } from "../../server/src/routes/durableNotes";
import { agentRunRoutes } from "../../server/src/routes/agentRuns";
import { feedbackRoutes } from "../../server/src/routes/feedback";
import { designsRoutes } from "../../server/src/routes/designs";
import { agentRoutes, type AgentSessionHost } from "../../server/src/routes/agent";
import type { ArtifactStore } from "../../server/src/agent/artifactStore";
import type { LlmStreamer } from "../../server/src/llm";
import type { ImageBlobStore } from "../../server/src/attachmentStore";
import { ensureBudgetSchema, spentMicroUsd } from "./budget";

/** Route prefixes whose absence would silently break the deployed client while
 * the origin still answers 200 on "/". The CI route-parity test (routeParity.
 * test.ts) guards this list against createApp at build time; the /api/online/
 * health probe re-checks it against the live route table so a bad deploy or
 * partial rollout is caught in production, not by a user opening the app. */
export const REQUIRED_ONLINE_ROUTES = ["/api/designs", "/api/conversations", "/api/settings"];

/** The one model the shared demo key funds. Single source of truth for the
 * chat path's default model below and for the LLM proxy's demo allowlist
 * (llmProxy.ts): demo cost is priced from this model's rates (demoPricing.ts),
 * so demo traffic must stay pinned to it - a different model would be mispriced
 * and could outrun the dollar caps. Deliberately not env-overridable - the chat
 * path's pin is not either. */
export const DEMO_MODEL_ID = "claude-sonnet-5";

/** Hosted agent turns (issue #51): the standard agent routes over the user's
 * container-backed session host, with the artifact served from R2. Present
 * only when the deployment is fully configured for hosting (container binding
 * plus CHAMFER_LLM_TOKEN_SECRET - userDo.ts decides); absent, the deployment
 * keeps the honest degraded posture: no /api/agent/* mounted, agentHosting
 * false, and "agent-hosting" listed under health degraded. */
export interface OnlineAgentHosting {
  sessions: AgentSessionHost;
  artifacts: ArtifactStore;
}

/** The per-user API surface, assembled from the same route modules as the
 * local server's createApp. Every route the deployed client depends on must be
 * mounted here; the only permitted gaps are the deliberate omissions below,
 * which routeParity.test.ts encodes as DELIBERATE_ONLINE_OMISSIONS so a newly
 * added server route can never silently skip the cloud again:
 * - no Fusion routes (a cloud Worker cannot reach a loopback MCP adapter);
 *   the client hides Fusion UI because experimentalFusionEnabled stays false
 * - no headless-run routes (no server-owned Pyodide runtime in a Worker);
 *   /api/runtime/capabilities answers { headlessRuns: false } instead
 * - no Langfuse/OTel observability (node-only SDK); agent-run lifecycle events
 *   still persist to the user's database
 * - no fake-LLM test controls
 */
export function createOnlineApp(
  db: DatabaseSync,
  llm: LlmStreamer,
  attachmentStore: ImageBlobStore,
  options: { release?: string; lifetimeMicroUsd?: number; demoQuota?: boolean; agent?: OnlineAgentHosting } = {},
): Hono {
  const app = new Hono();
  ensureBudgetSchema(db);
  // Fresh accounts chat on the demo quota without configuring anything; the
  // budget layer only honors Anthropic models, so the default must be one.
  const demoModel = getBuiltinModel("anthropic", DEMO_MODEL_ID);
  const defaultModelJson = options.demoQuota && demoModel ? JSON.stringify(demoModel) : undefined;
  app.get("/api/health", (c) => c.json({ ok: true }));
  // agentHosting follows options.agent (the per-user container wiring);
  // headlessRuns is permanently false online - a Worker has no server-owned
  // Python runtime, and hosted CAD execution lives in the container instead.
  // Unconfigured deployments answer agentHosting: false explicitly rather
  // than 404 so the client shows an honest notice instead of a dead composer.
  // demoQuota/demoModel tell the client which turns are fundable without a
  // user key, so the composer gate and status bar can be honest about what
  // will actually run (issue #53).
  app.get("/api/runtime/capabilities", (c) =>
    c.json({
      headlessRuns: false,
      agentHosting: Boolean(options.agent),
      demoQuota: Boolean(options.demoQuota && demoModel),
      ...(options.demoQuota && demoModel
        ? { demoModel: { id: demoModel.id, name: demoModel.name, provider: demoModel.provider } }
        : {}),
    }),
  );
  // Deep health: assert the client-critical route surface actually mounted in
  // this Durable Object. Returns 503 (not 200) when a required route is absent
  // so an uptime monitor alerts on functional breakage, not just origin death.
  // `degraded` names the capabilities this deployment knowingly lacks.
  app.get("/api/online/health", (c) => {
    const mounted = new Set(app.routes.map((route) => route.path));
    const missing = REQUIRED_ONLINE_ROUTES.filter((path) => !mounted.has(path));
    const degraded = options.agent ? [] : ["agent-hosting"];
    return c.json(
      { ok: missing.length === 0, service: "chamfer-online", missing, degraded },
      missing.length === 0 ? 200 : 503,
    );
  });
  // This account's lifetime demo spend against its cap, in dollars. The client
  // renders no meter today; this is an operational/debug view.
  app.get("/api/online/budget", (c) => {
    const spent = spentMicroUsd(db);
    const cap = options.lifetimeMicroUsd ?? 0;
    return c.json({
      spentUsd: spent / 1e6,
      capUsd: cap / 1e6,
      spentMicroUsd: spent,
      capMicroUsd: cap,
    });
  });
  app.route("/", settingsRoutes(db, false, defaultModelJson));
  app.route("/", modelsRoutes(false));
  app.route("/", streamRoutes(db, llm));
  // The demo default model also backs server-initiated calls (title
  // generation): a fresh account has no settings row, and the budget layer
  // injects the demo key exactly like the chat path.
  app.route("/", conversationsRoutes(db, llm, attachmentStore, { defaultModelJson }));
  app.route("/", designsRoutes(db));
  app.route("/", evidenceRoutes(db, attachmentStore));
  app.route("/", imageDiagnosticsRoutes(db, attachmentStore));
  app.route("/", durableNoteRoutes(db));
  app.route("/", agentRunRoutes(db, { release: options.release ?? "online" }));
  app.route("/", feedbackRoutes(db));
  app.route("/", artifactsRoutes(db));
  // Mounted last, and only when hosting is configured: the same agentRoutes
  // module the local server and the container use, so the browser-facing
  // contract (202 prompt, SSE events, artifact ETags) is identical everywhere.
  if (options.agent) {
    app.route("/", agentRoutes(db, options.agent.sessions, options.agent.artifacts));
  }
  return app;
}
