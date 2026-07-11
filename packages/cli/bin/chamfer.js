#!/usr/bin/env node
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const major = Number(process.versions.node.split(".")[0]);
if (major < 22) {
  console.error(`Chamfer needs Node.js >= 22.19 (found ${process.versions.node}).`);
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(`chamfer — AI CAD designer in your browser

Usage: npx chamfer [--port <n>]

Data is stored in ~/.chamfer (override with CHAMFER_DATA_DIR).
Add your API key in Settings after the app opens, or put it in a
.env / .env.local file in the directory you run chamfer from.`);
  process.exit(0);
}

const portFlag = args.indexOf("--port");
const port = portFlag !== -1 ? Number(args[portFlag + 1]) : undefined;
if (portFlag !== -1 && !Number.isInteger(port)) {
  console.error("--port expects an integer, e.g. --port 8788");
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));

const { startServer, loadDotenv } = await import(pathToFileURL(join(here, "../dist/server.mjs")).href);
for (const file of loadDotenv().files) {
  console.log(`chamfer: loaded environment from ${file}`);
}

const dataDir = process.env.CHAMFER_DATA_DIR ?? join(homedir(), ".chamfer");
startServer({
  dbPath: join(dataDir, "chamfer.db"),
  clientDist: join(here, "../dist/client"),
  port,
});
