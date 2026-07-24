// Assembles the Docker build context for the hosted agent container image:
// bundles the server's container entry (including the private @chamfer/shared
// workspace) into dist/server.mjs and stages the repo's patch-package patches
// into dist/patches so the image applies the exact same dependency patches the
// workspace runs with. Runtime npm deps stay external - they are installed
// inside the image from runtime-package.json (same split as packages/cli).
// Run from a workspace with node_modules installed; docker build follows with
// this directory as its context (see smoke.mjs).
import { build } from "esbuild";
import { cpSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

const runtime = JSON.parse(readFileSync(here("./runtime-package.json"), "utf8"));
const external = Object.keys(runtime.dependencies).flatMap((d) => [d, `${d}/*`]);

rmSync(here("./dist"), { recursive: true, force: true });

await build({
  entryPoints: [here("../../server/src/container/entry.ts")],
  outfile: here("./dist/server.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external,
});

cpSync(here("../../../patches"), here("./dist/patches"), { recursive: true });
console.log("container context assembled: dist/server.mjs + dist/patches");
