import { fileURLToPath } from "node:url";
import { startServer } from "./startServer";

// Dev/repo entry: data lives in the repo-local data/ dir; the published CLI
// (packages/cli) calls startServer with a user data dir instead.
startServer({
  dbPath: fileURLToPath(new URL("../../../data/chamfer.db", import.meta.url)),
  clientDist: fileURLToPath(new URL("../../client/dist", import.meta.url)),
});
