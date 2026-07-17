import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import { settingsRoutes } from "./routes/settings";
import { modelsRoutes } from "./routes/models";
import { streamRoutes } from "./routes/stream";
import { conversationsRoutes } from "./routes/conversations";
import { artifactsRoutes } from "./routes/artifacts";
import { referenceRoutes } from "./routes/references";
import { realLlm, type LlmStreamer } from "./llm";
import { AgentRunTraceManager, observeLlm } from "./observability";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AttachmentStore, type AttachmentStoreOptions } from "./attachmentStore";
import { inspectionLeaseRoutes } from "./routes/inspectionLeases";
import { visualVerificationRoutes } from "./routes/visualVerifications";
import { imageDiagnosticsRoutes } from "./routes/imageDiagnostics";
import { fakeLlmTestControlRoutes } from "./routes/fakeLlmTestControls";
import { FusionConnector, type FusionReadinessProvider } from "./fusion/readiness";
import { fusionRoutes } from "./routes/fusion";
import { FusionOwnership } from "./fusion/ownership";
import type { FusionDocumentationProvider } from "./fusion/documentation";
import { FusionActions, type FusionActionRuntime } from "./fusion/action";
import { FusionLifecycle, type FusionLifecycleRuntime } from "./fusion/lifecycle";
import { sourceSpecificationRoutes } from "./routes/sourceSpecifications";
import { proofContractRoutes } from "./routes/proofContracts";
import { designEscalationRoutes } from "./routes/designEscalations";
import { referenceRegistrationRoutes } from "./routes/referenceRegistrations";
import { proofReportRoutes } from "./routes/proofReports";
import { agentRunRoutes } from "./routes/agentRuns";
import { storeAgentRunTraceReference } from "./agentRunLifecycle";
import { feedbackRoutes } from "./routes/feedback";
import { createLangfuseSyncTransportFromEnv } from "./evaluation/langfuseClientTransport";
import type { LangfuseSyncTransport } from "./evaluation/langfuseExperimentSync";
import { recordCompletedRunMonitoring } from "./evaluation/onlineMonitoring";

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
  app.get("/api/health", (c) => c.json({ ok: true }));
  app.route("/", settingsRoutes(db));
  app.route("/", modelsRoutes());
  app.route("/", streamRoutes(db, observeLlm(llm, "chat-response", agentRunTraceManager)));
  app.route("/", conversationsRoutes(db, observeLlm(llm, "conversation-title", agentRunTraceManager), attachmentStore));
  app.route("/", referenceRoutes(db, attachmentStore));
  app.route("/", inspectionLeaseRoutes(db, attachmentStore));
  app.route("/", visualVerificationRoutes(db));
  app.route("/", imageDiagnosticsRoutes(db, attachmentStore));
  app.route("/", fakeLlmTestControlRoutes(db, llm));
  app.route("/", fusionRoutes(fusionOwnership, fusionDocumentation, fusionActions, fusionLifecycle));
  app.route("/", sourceSpecificationRoutes(db));
  app.route("/", proofContractRoutes(db));
  app.route("/", proofReportRoutes(db));
  app.route("/", designEscalationRoutes(db));
  app.route("/", referenceRegistrationRoutes(db));
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
