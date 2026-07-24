import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDotenv, startServer } from "./startServer";

// Dev/repo entry: data lives in the repo-local data/ dir; the published CLI
// (packages/cli) calls startServer with a user data dir instead.
// CHAMFER_DATA_DIR overrides the data dir here too, so an e2e run can point
// its own dev stack at a scratch database.
for (const file of loadDotenv().files) {
  console.log(`chamfer: loaded environment from ${file}`);
}
void startServer({
  dbPath: process.env.CHAMFER_DATA_DIR
    ? join(process.env.CHAMFER_DATA_DIR, "chamfer.db")
    : fileURLToPath(new URL("../../../data/chamfer.db", import.meta.url)),
  clientDist: fileURLToPath(new URL("../../client/dist", import.meta.url)),
  agentSkillsDir: fileURLToPath(new URL("../../client/src/agent", import.meta.url)),
}).catch((error: unknown) => {
  console.error("chamfer: startup failed", error);
  process.exitCode = 1;
});
