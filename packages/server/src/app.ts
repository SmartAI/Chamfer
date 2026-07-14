import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import { settingsRoutes } from "./routes/settings";
import { modelsRoutes } from "./routes/models";
import { streamRoutes } from "./routes/stream";
import { conversationsRoutes } from "./routes/conversations";
import { artifactsRoutes } from "./routes/artifacts";
import { referenceRoutes } from "./routes/references";
import { realLlm, type LlmStreamer } from "./llm";
import { observeLlm } from "./observability";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AttachmentStore, type AttachmentStoreOptions } from "./attachmentStore";
import { inspectionLeaseRoutes } from "./routes/inspectionLeases";
import { visualVerificationRoutes } from "./routes/visualVerifications";
import { imageDiagnosticsRoutes } from "./routes/imageDiagnostics";
import { fakeLlmTestControlRoutes } from "./routes/fakeLlmTestControls";

export interface AppOptions extends AttachmentStoreOptions {
  dataDir?: string;
}

export function createApp(db: DatabaseSync, llm: LlmStreamer = realLlm(), options: AppOptions = {}): Hono {
  const app = new Hono();
  const dataDir = options.dataDir ?? join(tmpdir(), "chamfer-memory-data", String(process.pid));
  const attachmentStore = new AttachmentStore(dataDir, options);
  app.get("/api/health", (c) => c.json({ ok: true }));
  app.route("/", settingsRoutes(db));
  app.route("/", modelsRoutes());
  app.route("/", streamRoutes(db, observeLlm(llm, "chat-response")));
  app.route("/", conversationsRoutes(db, observeLlm(llm, "conversation-title"), attachmentStore));
  app.route("/", referenceRoutes(db, attachmentStore));
  app.route("/", inspectionLeaseRoutes(db, attachmentStore));
  app.route("/", visualVerificationRoutes(db));
  app.route("/", imageDiagnosticsRoutes(db, attachmentStore));
  app.route("/", fakeLlmTestControlRoutes(db, llm));
  app.route("/", artifactsRoutes(db));
  return app;
}
