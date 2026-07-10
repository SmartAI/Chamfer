// Assembles the publishable `chamfer` package: bundles the server (including
// the private @chamfer/shared workspace) into dist/server.mjs, and copies the
// built client into dist/client. npm deps stay external — they are regular
// dependencies of this package. Requires the client to be built first (the
// root `npm run build` handles ordering).
import { build } from "esbuild";
import { cpSync, existsSync, rmSync, copyFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

// External = exactly this package's npm dependencies (plus their subpath
// imports). Everything else — the server source and the private
// @chamfer/shared workspace — gets bundled.
const pkg = JSON.parse(readFileSync(here("../package.json"), "utf8"));
const external = Object.keys(pkg.dependencies).flatMap((d) => [d, `${d}/*`]);

const clientDist = here("../../client/dist");
if (!existsSync(clientDist)) {
  console.error("packages/client/dist not found — build the client first (npm run build from the repo root).");
  process.exit(1);
}

rmSync(here("../dist"), { recursive: true, force: true });

await build({
  entryPoints: [here("../../server/src/startServer.ts")],
  outfile: here("../dist/server.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external,
});

cpSync(clientDist, here("../dist/client"), { recursive: true });
copyFileSync(here("../../../NOTICE"), here("../NOTICE"));
copyFileSync(here("../../../LICENSE"), here("../LICENSE"));
console.log("chamfer package assembled: dist/server.mjs + dist/client");
