import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import { settingsRoutes } from "./routes/settings";
import { modelsRoutes } from "./routes/models";
import { streamRoutes } from "./routes/stream";
import { conversationsRoutes } from "./routes/conversations";
import { artifactsRoutes } from "./routes/artifacts";
import { realLlm, type LlmStreamer } from "./llm";

export function createApp(db: DatabaseSync, llm: LlmStreamer = realLlm()): Hono {
  const app = new Hono();
  app.get("/api/health", (c) => c.json({ ok: true }));
  app.route("/", settingsRoutes(db));
  app.route("/", modelsRoutes());
  app.route("/", streamRoutes(db, llm));
  app.route("/", conversationsRoutes(db, llm));
  app.route("/", artifactsRoutes(db));
  return app;
}
