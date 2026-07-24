// Builds the agent container image and pushes it to the Cloudflare registry
// under exactly the name:tag pinned in wrangler.jsonc, so the pushed image and
// the deployed reference cannot drift. Run this (needs local Docker and a
// wrangler login carrying the containers scopes) after bumping the pinned tag,
// before merging any container-affecting change; Workers Builds only
// references the image and can never build it.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const config = readFileSync(join(packageDir, "wrangler.jsonc"), "utf8");

const match = config.match(/"image":\s*"registry\.cloudflare\.com\/[^/"]+\/([^/":]+):([^"]+)"/);
if (!match) {
  console.error("container-push: wrangler.jsonc does not pin a registry.cloudflare.com image with a tag");
  process.exit(1);
}
const [, name, tag] = match;

const run = (command, args) => execFileSync(command, args, { cwd: packageDir, stdio: "inherit" });
run("node", ["container/build.mjs"]);
run("npx", ["wrangler", "containers", "build", "--push", "-t", `${name}:${tag}`, "./container"]);
console.log(`pushed ${name}:${tag}; wrangler.jsonc references it as-is`);
