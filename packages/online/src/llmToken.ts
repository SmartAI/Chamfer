import { SignJWT, jwtVerify } from "jose";

/** Short-lived conversation-scoped bearer tokens for the container-facing LLM
 * proxy (issue #48, ADR 0003).
 *
 * The agent container never holds a real provider key: the user's Durable
 * Object mints one of these per turn (wired in increment 3) and hands it to
 * the container's pi session as its "API key". The Worker's proxy route
 * verifies it and injects the real key upstream, so the worst a hostile
 * prompt inside the container can spend is its own already-metered token.
 *
 * Format: a standard JWT signed HS256 via jose (WebCrypto-backed, so it runs
 * natively on Workers and Node >= 20; no node:crypto). Claims use standard
 * names where they exist - `sub` is the user id, `exp` the expiry - plus the
 * private claim `cnv` for the conversation id. The signing secret is
 * CHAMFER_LLM_TOKEN_SECRET.
 *
 * Minting and verification both run on Cloudflare against the same clock, so
 * verification applies no clock-skew grace: the TTL itself is the slack. The
 * default covers one long agent turn (many LLM calls around CAD runs) with
 * modest headroom; it is deliberately far shorter than a session cookie.
 */

export interface LlmTokenClaims {
  userId: string;
  conversationId: string;
  /** Absolute expiry as Unix epoch seconds. */
  expiresAt: number;
}

export const DEFAULT_LLM_TOKEN_TTL_SECONDS = 15 * 60;

const encoder = new TextEncoder();

export async function mintLlmToken(
  secret: string,
  claims: { userId: string; conversationId: string; ttlSeconds?: number },
  nowMs: number = Date.now(),
): Promise<string> {
  const expiresAt =
    Math.floor(nowMs / 1000) + (claims.ttlSeconds ?? DEFAULT_LLM_TOKEN_TTL_SECONDS);
  return await new SignJWT({ cnv: claims.conversationId })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.userId)
    .setExpirationTime(expiresAt)
    .sign(encoder.encode(secret));
}

/** Returns the claims of a valid, unexpired token; null for anything else.
 * Never throws on malformed input: every request on the public proxy route
 * funnels through here. jose pins the algorithm to HS256 (so alg:none or
 * downgraded tokens are rejected) and enforces `exp` against the injected
 * clock with zero tolerance. */
export async function verifyLlmToken(
  secret: string,
  token: string,
  nowMs: number = Date.now(),
): Promise<LlmTokenClaims | null> {
  let payload: { sub?: string; exp?: number; cnv?: unknown };
  try {
    ({ payload } = await jwtVerify(token, encoder.encode(secret), {
      algorithms: ["HS256"],
      requiredClaims: ["sub", "exp", "cnv"],
      currentDate: new Date(nowMs),
      clockTolerance: 0,
    }));
  } catch {
    return null;
  }
  const { sub, exp, cnv } = payload;
  if (typeof sub !== "string" || typeof exp !== "number" || typeof cnv !== "string") return null;
  return { userId: sub, conversationId: cnv, expiresAt: exp };
}
