/** Header the Worker stamps on session-authenticated requests it forwards to
 * the user's Durable Object, carrying the authenticated user id (the DO's
 * name is an opaque hash of it, so the DO cannot recover it otherwise). The
 * DO mints conversation-scoped LLM proxy tokens with it (`sub` claim), which
 * is why it is trust-critical: the Worker must SET it (never append, so a
 * client-supplied copy cannot survive), and the token-authenticated proxy
 * gate must strip it from container-originated traffic - a hostile prompt
 * forging it there could otherwise poison future mints with another user's
 * id and spend their budget. */
export const CHAMFER_USER_ID_HEADER = "x-chamfer-user-id";

/** Bindings and configuration for the chamfer-online Worker. */
export interface OnlineEnv {
  ASSETS: Fetcher;
  USER_DO: DurableObjectNamespace;
  AUTH_DB: D1Database;
  /** Image attachment blobs, keyed under each user's Durable Object id. */
  ATTACHMENTS: R2Bucket;
  /** Per-user agent containers (ChamferAgentContainer, issue #50). Optional:
   * unit tests and hermetic probe configs run without a containers block, and
   * the probe route reports that state instead of crashing. */
  AGENT_CONTAINER?: DurableObjectNamespace;

  /** better-auth signing secret (wrangler secret). */
  BETTER_AUTH_SECRET?: string;
  /** Public origin, e.g. https://chamferonline.com. Defaults to the request origin. */
  BETTER_AUTH_URL?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;

  /** Server-held Anthropic key funding signed-in users without their own key.
   * Deliberately NOT named ANTHROPIC_API_KEY: settingsStore reads that name
   * from process.env, which would leak a masked form of the demo key through
   * GET /api/settings and bypass the budget path. */
  CHAMFER_DEMO_ANTHROPIC_KEY?: string;
  CHAMFER_DEMO_ANTHROPIC_BASE_URL?: string;
  /** Cloudflare Access service token guarding the demo funding gateway's
   * `cloudflared` tunnel (CHAMFER_DEMO_ANTHROPIC_BASE_URL). Set both to make
   * the two demo upstream paths present `CF-Access-Client-Id` /
   * `CF-Access-Client-Secret`, so Cloudflare's edge admits only this Worker to
   * the tunnel. Unset leaves the tunnel guarded by the gateway key alone. Never
   * sent on BYOK traffic. */
  CHAMFER_DEMO_ACCESS_CLIENT_ID?: string;
  CHAMFER_DEMO_ACCESS_CLIENT_SECRET?: string;
  /** Per-account LIFETIME demo spend cap, in whole USD (default 2). The demo is
   * a one-time taste, not a renewing allowance; see budget.ts. */
  CHAMFER_DEMO_LIFETIME_USD?: string;
  /** Global MONTHLY demo spend cap across all users, in whole USD (default 50) -
   * the hard ceiling on what the free demo can cost. See globalDemoBudget.ts. */
  CHAMFER_DEMO_MONTHLY_USD?: string;
  /** Per-turn CAD-execution cap for hosted turns (positive integer; product
   * default 10). Sizes the per-turn LLM token TTL and passes through to the
   * container boot env, so raising the cap keeps token runway aligned. */
  CHAMFER_MAX_CAD_RUNS?: string;

  /** Secret signing the short-lived conversation-scoped JWTs (HS256) that
   * authenticate the container-facing LLM proxy (wrangler secret). Unset
   * answers 503 on /api/llm/* and keeps agent hosting in the degraded
   * posture. See llmToken.ts / llmProxy.ts / agentTurns.ts. */
  CHAMFER_LLM_TOKEN_SECRET?: string;

  /** Local development only: treat every request as a fixed dev user. */
  CHAMFER_DEV_LOGIN?: string;

  /** Origin of the application host (e.g. https://app.chamferonline.com).
   * When set, sign-in flows land there instead of the current origin. */
  CHAMFER_APP_ORIGIN?: string;
  /** Local dev only (.dev.vars): the origin the agent container uses to reach
   * this Worker's LLM proxy from inside Docker, where wrangler dev's
   * localhost is unreachable (e.g. http://host.docker.internal:8787).
   * Production leaves this unset and boots containers with
   * CHAMFER_APP_ORIGIN. See agentContainerBootEnv. */
  CHAMFER_CONTAINER_LLM_ORIGIN?: string;
  /** The agent container image version this Worker expects (issue #56), mirroring
   * the tag pinned in wrangler.jsonc's `containers[].image`. The turn host and the
   * wake probe compare it against the container's reported /api/health version
   * and refuse on skew, catching a new Worker deployed against an old image (the
   * #55 incident). Bump it in lockstep with the image tag; unset disables the
   * handshake. See containerVersion.ts. */
  CHAMFER_EXPECTED_CONTAINER_VERSION?: string;
  /** Origin of the marketing/landing host (e.g. https://chamferonline.com).
   * When set, signed-out visitors on the app host are sent there. */
  CHAMFER_LANDING_ORIGIN?: string;
  /** Cookie domain spanning landing and app hosts (e.g. .chamferonline.com). */
  CHAMFER_COOKIE_DOMAIN?: string;
  /** Comma-separated origins better-auth may redirect to after sign-in. */
  CHAMFER_TRUSTED_ORIGINS?: string;

  /** Sentry ingest DSN for the Worker (wrangler secret). Unset disables it. */
  SENTRY_DSN?: string;
  /** Sentry environment tag, e.g. "production". */
  SENTRY_ENVIRONMENT?: string;
  /** Release identifier shared with Sentry and agent-run lifecycle traces. */
  CHAMFER_RELEASE?: string;
}

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  image?: string | null;
}
