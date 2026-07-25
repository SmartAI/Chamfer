// One reader for the container image reference pinned in wrangler.jsonc, shared
// by every tool that must agree on it: container-push.mjs (pushes under it),
// container/build.mjs (bakes the tag into the image), and check-container-skew.mjs
// (the CI guard). A lightweight regex rather than a JSONC parser dependency -
// the field's shape is fixed and this keeps the build/deploy scripts dep-free.
import { readFileSync } from "node:fs";

const IMAGE_RE = /"image":\s*"(registry\.cloudflare\.com\/[^/"]+\/([^/":]+)):([^"]+)"/;
const EXPECTED_VERSION_RE = /"CHAMFER_EXPECTED_CONTAINER_VERSION":\s*"([^"]*)"/;

/** The pinned image as { repository, name, tag } from a wrangler.jsonc string,
 * or undefined when no registry image is pinned. */
export function imageRefOf(wranglerJsonc) {
  const match = wranglerJsonc.match(IMAGE_RE);
  return match ? { repository: match[1], name: match[2], tag: match[3] } : undefined;
}

/** Just the pinned image tag from a wrangler.jsonc string. */
export function imageTagOf(wranglerJsonc) {
  return imageRefOf(wranglerJsonc)?.tag;
}

/** The Worker's expected container version (the handshake's other side). */
export function expectedVersionOf(wranglerJsonc) {
  const match = wranglerJsonc.match(EXPECTED_VERSION_RE);
  return match ? match[1] : undefined;
}

/** Reads the package's own wrangler.jsonc. Callers in scripts/ and container/
 * both sit one directory below the package root. */
export function readWranglerConfig(fromUrl) {
  return readFileSync(new URL("../wrangler.jsonc", fromUrl), "utf8");
}
