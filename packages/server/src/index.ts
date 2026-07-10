import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { openDb } from "./db";
import { createApp } from "./app";
import { fakeLlm } from "./fakeLlm";

const port = process.env.PORT ? Number(process.env.PORT) : 8787;

const db = openDb(new URL("../../../data/chamfer.db", import.meta.url).pathname);
const app = createApp(db, process.env.CHAMFER_FAKE_LLM === "1" ? fakeLlm() : undefined);

// Production static hosting: when the client has been built (npm run build),
// serve it from this server so `npm start` runs the whole app. The API routes
// registered by createApp win first; anything else is looked up in the client
// dist, and unknown non-/api paths fall back to the SPA's index.html. In dev
// there is no dist directory, so this block is skipped and Vite serves the
// client. Lives here (not in app.ts) to keep createApp's test surface API-only.
const clientDist = fileURLToPath(new URL("../../client/dist", import.meta.url));
if (existsSync(clientDist)) {
  const spaFallback = serveStatic({ root: clientDist, path: "index.html" });
  app.use("*", serveStatic({ root: clientDist }));
  app.get("*", (c, next) => {
    if (c.req.path.startsWith("/api")) return next();
    return spaFallback(c, next);
  });
}

serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, (info) => {
  console.log(`chamfer server on http://127.0.0.1:${info.port}`);
});
