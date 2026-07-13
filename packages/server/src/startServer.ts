import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { openDb } from "./db";
import { createApp } from "./app";
import { fakeLlm } from "./fakeLlm";
import { realLlm } from "./llm";
import { initObservability } from "./observability";
import { prepareImageStorage } from "./startupImageStorage";

// Re-exported so the published CLI (which bundles this file as its entry)
// can load .env/.env.local before it reads CHAMFER_DATA_DIR/PORT.
export { loadDotenv } from "./envConfig";

export interface StartServerOptions {
  dbPath: string;
  /** Absolute path to the built client; static hosting is skipped if absent. */
  clientDist?: string;
  port?: number;
}

export async function startServer(opts: StartServerOptions) {
  const port = opts.port ?? (process.env.PORT ? Number(process.env.PORT) : 8787);

  initObservability();
  const db = openDb(opts.dbPath);
  const { migration, maintenance } = await prepareImageStorage(db, dirname(opts.dbPath));
  if (!migration.alreadyComplete) {
    console.log(
      `chamfer: image migration migrated=${migration.migrated} broken=${migration.broken} normalized_messages=${migration.normalizedMessages}`,
    );
    for (const diagnostic of migration.diagnostics) {
      console.warn(
        `chamfer: image migration attachment=${diagnostic.attachmentId} message=${diagnostic.messageId} code=${diagnostic.code}`,
      );
    }
  }
  if (maintenance.removed.length > 0 || maintenance.failed.length > 0) {
    console.log(
      `chamfer: image maintenance removed=${maintenance.removed.length} failed=${maintenance.failed.length}`,
    );
  }
  const llm = process.env.CHAMFER_FAKE_LLM === "1" ? fakeLlm() : realLlm();
  const app = createApp(db, llm, { dataDir: dirname(opts.dbPath) });

  // Production static hosting: when a built client is available, serve it from
  // this server so one process runs the whole app. The API routes registered
  // by createApp win first; anything else is looked up in the client dist, and
  // unknown non-/api paths fall back to the SPA's index.html. In dev there is
  // no dist directory, so this block is skipped and Vite serves the client.
  // Lives here (not in app.ts) to keep createApp's test surface API-only.
  if (opts.clientDist && existsSync(opts.clientDist)) {
    const clientDist = opts.clientDist;
    const spaFallback = serveStatic({ root: clientDist, path: "index.html" });
    app.use("*", serveStatic({ root: clientDist }));
    app.get("*", (c, next) => {
      if (c.req.path.startsWith("/api")) return next();
      return spaFallback(c, next);
    });
  }

  return serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, (info) => {
    console.log(`chamfer server on http://127.0.0.1:${info.port}`);
  });
}
