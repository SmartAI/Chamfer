/** Worker/container image version handshake (issue #56).
 *
 * The hosted agent runs as two independently deployed layers: the Worker
 * (deployed from source on every push) and the container image (a pre-built
 * reference pinned by tag in wrangler.jsonc, rebuilt and pushed only when a
 * human runs container-image.yml). When container-shipped code changes but the
 * pinned tag does not, production runs a new Worker against an old container -
 * the #55 incident, where mismatched layers silently exchanged a bodiless 404.
 *
 * The image bakes its own version (the pinned tag, stamped in by build.mjs) and
 * reports it on /api/health; the Worker knows the version it expects
 * (CHAMFER_EXPECTED_CONTAINER_VERSION, set beside the image tag in
 * wrangler.jsonc). Comparing the two at wake turns silent garbage into a loud,
 * operator-facing refusal.
 */

/** The version a legacy image built before this handshake reports: none. */
export const UNKNOWN_CONTAINER_VERSION = "unknown";

/** Compares the version this deployment expects against the one the running
 * container reports, returning an operator-facing refusal message on skew or
 * `undefined` when the turn may proceed.
 *
 * - `expected` unset -> handshake not configured (older deployment config, or a
 *   hermetic test): never blocks a turn.
 * - versions equal -> match, proceed.
 * - versions differ, or the container reports no version (a legacy image
 *   predating the handshake) -> skew, refuse. */
export function containerVersionSkewMessage(
  expected: string | undefined,
  actual: string | undefined,
): string | undefined {
  if (!expected) return undefined;
  const reported = actual && actual !== UNKNOWN_CONTAINER_VERSION ? actual : undefined;
  if (reported === expected) return undefined;
  const seen = reported
    ? `the running container reports version ${reported}`
    : "the running container reports no version (a legacy image predating the handshake)";
  return (
    `Hosted agent container image skew: this deployment expects container version ${expected}, but ` +
    `${seen}. Bump the pinned image tag in packages/online/wrangler.jsonc, run container-image.yml to ` +
    `push the matching image, then redeploy - the layers must not exchange requests until they agree.`
  );
}
