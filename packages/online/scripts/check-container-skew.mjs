// Guard 2 of the Worker/container version handshake (issue #56): a PR check
// that fails when container-shipped code moves without the pinned image tag
// moving with it - the heuristic backstop to the runtime handshake. It also
// enforces the invariant that the image tag and CHAMFER_EXPECTED_CONTAINER_VERSION
// in wrangler.jsonc stay equal (the two sides of the handshake).
//
// Heuristic by design: the whole server bundle ships in the image, so this
// watches only the two obviously-container directories. Everything it misses,
// the runtime handshake (containerVersion.ts) still catches at wake.
//
// CI invokes it on pull_request with GITHUB_BASE_REF set. The core comparison
// is a pure function (evaluateContainerSkew) so it is unit-tested without git.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { imageTagOf, expectedVersionOf } from "./wrangler-image.mjs";

// Re-exported so this module's test can exercise the readers alongside the
// pure verdict below; the canonical definitions live in wrangler-image.mjs.
export { imageTagOf, expectedVersionOf };

/** Directories whose contents ship inside the container image. */
export const CONTAINER_PATH_PREFIXES = ["packages/online/container/", "packages/server/src/container/"];

const WRANGLER_PATH = "packages/online/wrangler.jsonc";

/** Pure verdict over the facts CI gathers. Two rules:
 *  1. The image tag and the expected-version var must always be equal.
 *  2. If container-shipped code changed, the image tag must differ from base. */
export function evaluateContainerSkew({ changedFiles, baseImageTag, headImageTag, headExpectedVersion }) {
  const errors = [];
  if (headImageTag !== headExpectedVersion) {
    errors.push(
      `wrangler.jsonc: the container image tag (${headImageTag ?? "missing"}) and ` +
        `CHAMFER_EXPECTED_CONTAINER_VERSION (${headExpectedVersion ?? "missing"}) must be equal - they are the ` +
        "two sides of the issue #56 version handshake.",
    );
  }
  const touched = changedFiles.filter((file) => CONTAINER_PATH_PREFIXES.some((prefix) => file.startsWith(prefix)));
  if (touched.length > 0 && baseImageTag !== undefined && headImageTag === baseImageTag) {
    const shown = touched.slice(0, 5).join(", ") + (touched.length > 5 ? ", ..." : "");
    errors.push(
      `Container-shipped code changed (${shown}) but the pinned image tag in ${WRANGLER_PATH} is still ` +
        `${baseImageTag}. Bump the tag and CHAMFER_EXPECTED_CONTAINER_VERSION together, then run ` +
        "container-image.yml to push the matching image before merge - otherwise a new Worker runs against an " +
        "old container (issue #56, the #55 incident).",
    );
  }
  return { ok: errors.length === 0, errors };
}

function gitChangedFiles(baseRef) {
  const out = execFileSync("git", ["diff", "--name-only", `${baseRef}...HEAD`], { encoding: "utf8" });
  return out.split("\n").map((line) => line.trim()).filter(Boolean);
}

function gitShow(ref, path) {
  try {
    return execFileSync("git", ["show", `${ref}:${path}`], { encoding: "utf8" });
  } catch {
    return undefined;
  }
}

function main() {
  const headConfig = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  const headImageTag = imageTagOf(headConfig);
  const headExpectedVersion = expectedVersionOf(headConfig);

  const baseRef = process.env.CONTAINER_SKEW_BASE_REF
    ?? (process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : undefined);

  let changedFiles = [];
  let baseImageTag;
  if (baseRef) {
    changedFiles = gitChangedFiles(baseRef);
    const baseConfig = gitShow(baseRef, WRANGLER_PATH);
    baseImageTag = baseConfig ? imageTagOf(baseConfig) : undefined;
  } else {
    console.log("container-skew: no base ref; checking the tag/expected-version equality invariant only.");
  }

  const { ok, errors } = evaluateContainerSkew({ changedFiles, baseImageTag, headImageTag, headExpectedVersion });
  if (!ok) {
    for (const error of errors) console.error(`::error::${error}`);
    process.exit(1);
  }
  console.log(`container-skew: OK (image tag ${headImageTag}).`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
