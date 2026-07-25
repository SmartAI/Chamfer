import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import { settingsRoutes } from "./routes/settings";
import { modelsRoutes } from "./routes/models";
import { streamRoutes } from "./routes/stream";
import { conversationsRoutes } from "./routes/conversations";
import { artifactsRoutes } from "./routes/artifacts";
import { realLlm, type LlmStreamer } from "./llm";
import { AgentRunTraceManager, observeLlm } from "./observability";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { AttachmentStore, type AttachmentStoreOptions } from "./attachmentStore";
import { imageDiagnosticsRoutes } from "./routes/imageDiagnostics";
import { fakeLlmTestControlRoutes } from "./routes/fakeLlmTestControls";
import { FusionConnector, type FusionReadinessProvider } from "./fusion/readiness";
import { fusionRoutes } from "./routes/fusion";
import { FusionOwnership } from "./fusion/ownership";
import type { FusionDocumentationProvider } from "./fusion/documentation";
import { FusionActions, type FusionActionRuntime } from "./fusion/action";
import { FusionLifecycle, type FusionLifecycleRuntime } from "./fusion/lifecycle";
import { durableNoteRoutes } from "./routes/durableNotes";
import { agentRunRoutes } from "./routes/agentRuns";
import { storeAgentRunTraceReference } from "./agentRunLifecycle";
import { feedbackRoutes } from "./routes/feedback";
import { createLangfuseSyncTransportFromEnv } from "./evaluation/langfuseClientTransport";
import type { LangfuseSyncTransport } from "./evaluation/langfuseExperimentSync";
import { recordCompletedRunMonitoring } from "./evaluation/onlineMonitoring";
import { designsRoutes } from "./routes/designs";
import { evidenceRoutes } from "./routes/evidence";
import { agentRoutes } from "./routes/agent";
import { PiAgentSessions } from "./agent/piSession";
import { LocalArtifactStore } from "./agent/artifactStore";
import { FAKE_MODEL } from "./fakeLlm";

export interface AppOptions extends AttachmentStoreOptions {
  dataDir?: string;
  fusionReadiness?: FusionReadinessProvider;
  fusionDocumentation?: FusionDocumentationProvider;
  fusionActionRuntime?: FusionActionRuntime;
  fusionLifecycleRuntime?: FusionLifecycleRuntime;
  /** Server-owned deployment identity attached to lifecycle traces. */
  release?: string;
  /** External tracing boundary override for focused hierarchy tests. */
  agentRunTraceManager?: AgentRunTraceManager;
  /** External score sink override for focused user-feedback tests. */
  feedbackScoreSink?: Pick<LangfuseSyncTransport, "upsertScore">;
}

export function createApp(db: DatabaseSync, llm: LlmStreamer = realLlm(), options: AppOptions = {}): Hono {
  const app = new Hono();
  const dataDir = options.dataDir ?? join(tmpdir(), "chamfer-memory-data", String(process.pid));
  const attachmentStore = new AttachmentStore(dataDir, options);
  const fusionConnector = new FusionConnector(db);
  const fusionReadiness = options.fusionReadiness ?? fusionConnector;
  const fusionDocumentation = options.fusionDocumentation ?? fusionConnector;
  const fusionOwnership = new FusionOwnership(db, fusionReadiness);
  const fusionActions = new FusionActions(db, options.fusionActionRuntime ?? fusionConnector);
  const fusionLifecycle = new FusionLifecycle(db, options.fusionLifecycleRuntime ?? fusionConnector, fusionReadiness);
  const agentRunTraceManager = options.agentRunTraceManager ?? new AgentRunTraceManager();
  const feedbackScoreSink = options.feedbackScoreSink ?? createLangfuseSyncTransportFromEnv();
  // One store instance backs both the session host (turn-end recording) and
  // the artifact route (serving); local today, R2 on the hosted deployment.
  const artifactStore = new LocalArtifactStore(dataDir);
  const agentSessions = new PiAgentSessions(db, dataDir, artifactStore);
  app.get("/api/health", (c) => c.json({ ok: true }));
  // Deployment capability probe. Agent hosting is unconditional here: the pi
  // sessions run in this process. The Cloudflare Worker answers per its
  // container wiring (see packages/online/src/onlineApp.ts). Locally the only
  // keyless funding is the fake LLM (hermetic dev/e2e stacks), reported
  // through the same demoQuota shape the online demo key uses so the client's
  // provider-aware composer gate needs no special case.
  app.get("/api/runtime/capabilities", (c) => {
    const fakeMode = process.env.CHAMFER_FAKE_LLM === "1";
    return c.json({
      headlessRuns: false,
      agentHosting: true,
      demoQuota: fakeMode,
      ...(fakeMode ? { demoModel: { id: FAKE_MODEL.id, name: FAKE_MODEL.name, provider: FAKE_MODEL.provider } } : {}),
    });
  });
  app.route("/", agentRoutes(db, agentSessions, artifactStore));
  app.route("/", settingsRoutes(db));
  app.route("/", modelsRoutes());
  app.route("/", streamRoutes(db, observeLlm(llm, "chat-response", agentRunTraceManager)));
  app.route("/", conversationsRoutes(
    db,
    observeLlm(llm, "conversation-title", agentRunTraceManager),
    attachmentStore,
    { hasArtifact: (id) => artifactStore.exists(id) },
  ));
  app.route("/", designsRoutes(db));
  app.route("/", evidenceRoutes(db, attachmentStore));
  app.route("/", imageDiagnosticsRoutes(db, attachmentStore));
  app.route("/", fakeLlmTestControlRoutes(db, llm));
  app.route("/", fusionRoutes(fusionOwnership, fusionDocumentation, fusionActions, fusionLifecycle));
  app.route("/", durableNoteRoutes(db));
  app.route("/", agentRunRoutes(db, {
    release: options.release ?? process.env.LANGFUSE_RELEASE ?? process.env.CHAMFER_RELEASE ?? "unversioned",
    onEvent: (run, event) => {
      const reference = agentRunTraceManager.record(run, event);
      if (reference) storeAgentRunTraceReference(db, run.id, reference);
      if (event.type === "run.completed") recordCompletedRunMonitoring(db, run);
    },
  }));
  app.route("/", feedbackRoutes(db, { scoreSink: feedbackScoreSink }));
  app.route("/", artifactsRoutes(db));
  return app;
}
