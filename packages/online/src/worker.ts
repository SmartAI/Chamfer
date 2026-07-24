import { Hono } from "hono";
import * as Sentry from "@sentry/cloudflare";
import { createAuth } from "./auth";
import { llmProxyGate } from "./llmProxy";
import { CHAMFER_USER_ID_HEADER, type OnlineEnv, type SessionUser } from "./env";

export { ChamferUserDurableObject } from "./userDo";
export { ChamferAgentContainer } from "./agentContainerDo";

const DEV_USER: SessionUser = {
  id: "dev-user",
  name: "Dev User",
  email: "dev@localhost",
  image: null,
};

type Variables = { user: SessionUser };

/** Session cookies minted before CHAMFER_COOKIE_DOMAIN existed are host-only.
 * Browsers send them alongside the current domain-wide cookie, list them first
 * (older creation time), and better-auth's cookie parser keeps the first
 * occurrence - so a dead relic permanently shadows a valid session on that
 * host. better-auth's own sign-out cannot remove it either: its expiry carries
 * the Domain attribute, which never matches a host-only cookie. When a session
 * cookie was presented but resolved to no session, expire the host-only
 * variant (no Domain attribute) so affected browsers self-heal on the next
 * request. Expiring a cookie that does not exist is a no-op, so this is safe
 * when only the domain-wide cookie was sent. */
export function expireHostOnlySessionCookies(
  requestHeaders: Headers,
  setHeader: (name: string, value: string, options?: { append: boolean }) => void,
): void {
  const cookieHeader = requestHeaders.get("cookie");
  if (!cookieHeader) return;
  const names = new Set(
    cookieHeader
      .split(";")
      .map((part) => part.slice(0, part.indexOf("=")).trim())
      .filter((name) => name === "better-auth.session_token" || name === "__Secure-better-auth.session_token"),
  );
  for (const name of names) {
    const secure = name.startsWith("__Secure-") ? " Secure;" : "";
    setHeader("Set-Cookie", `${name}=; Max-Age=0; Path=/;${secure} HttpOnly; SameSite=Lax`, {
      append: true,
    });
  }
}

const app = new Hono<{ Bindings: OnlineEnv; Variables: Variables }>();

// better-auth owns /api/auth/* (sign-in, OAuth callbacks, sign-out, session).
// Registered before the session middleware: these endpoints must be reachable
// signed-out.
app.on(["GET", "POST"], "/api/auth/*", (c) =>
  createAuth(c.env, new URL(c.req.url).origin).handler(c.req.raw),
);

// Public deployment facts the sign-in screen needs before a session exists.
app.get("/api/online/config", (c) =>
  c.json({
    online: true,
    demoQuota: Boolean(c.env.CHAMFER_DEMO_ANTHROPIC_KEY),
    providers: {
      google: Boolean(c.env.GOOGLE_CLIENT_ID && c.env.GOOGLE_CLIENT_SECRET),
      github: Boolean(c.env.GITHUB_CLIENT_ID && c.env.GITHUB_CLIENT_SECRET),
    },
    devLogin: c.env.CHAMFER_DEV_LOGIN === "1",
    appOrigin: c.env.CHAMFER_APP_ORIGIN,
    landingOrigin: c.env.CHAMFER_LANDING_ORIGIN,
  }),
);

// Public liveness + route-surface probe (no session, so an uptime monitor can
// reach it): forwards to a dedicated health Durable Object, exercising DO boot,
// schema init, and the mounted route table end to end. The DO answers 503 when
// a client-critical route is missing - see onlineApp.ts /api/online/health -
// which is exactly the failure a plain GET "/" would miss.
app.get("/api/online/health", (c) => {
  const namespace = c.env.USER_DO;
  const stub = namespace.get(namespace.idFromName("__system_health__"));
  // This route is public and pre-session: strip the user-id header so a
  // caller-supplied value can never reach a DO (the set-never-append
  // invariant in env.ts holds on every DO ingress path).
  const forwarded = new Request(c.req.raw);
  forwarded.headers.delete(CHAMFER_USER_ID_HEADER);
  return stub.fetch(forwarded);
});

// The container-facing LLM proxy authenticates by short-lived conversation
// token, not by session cookie (the agent container has no cookie jar), so it
// must be registered before the session middleware below. The gate verifies
// the token and routes to the Durable Object of the user the token names -
// the same user-id-only routing rule as the session path. See llmProxy.ts for
// the full contract the container consumes.
app.route("/", llmProxyGate());

// Everything else under /api requires a session.
app.use("/api/*", async (c, next) => {
  if (c.env.CHAMFER_DEV_LOGIN === "1") {
    c.set("user", DEV_USER);
    return next();
  }
  const auth = createAuth(c.env, new URL(c.req.url).origin);
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) {
    expireHostOnlySessionCookies(c.req.raw.headers, c.header.bind(c));
    return c.json({ error: "unauthorized" }, 401);
  }
  const { id, name, email, image } = session.user;
  c.set("user", { id, name, email, image });
  return next();
});

app.get("/api/me", (c) => c.json({ user: c.get("user") }));

// The user's entire API surface lives in their Durable Object; route by the
// authenticated user id, never by anything client-supplied. The id also rides
// along as a header (set, never appended - a client-sent copy dies here): the
// DO needs it to mint conversation-scoped LLM proxy tokens for hosted agent
// turns, and its own id is only a hash of it.
app.all("/api/*", (c) => {
  const namespace = c.env.USER_DO;
  const userId = c.get("user").id;
  const stub = namespace.get(namespace.idFromName(userId));
  const forwarded = new Request(c.req.raw);
  forwarded.headers.set(CHAMFER_USER_ID_HEADER, userId);
  return stub.fetch(forwarded);
});

// Wrap the front router so uncaught exceptions - in auth, session resolution,
// or a rejected Durable Object subrequest - reach Sentry. When SENTRY_DSN is
// unset (local dev, self-host) the SDK initializes disabled and sends nothing.
// Durable-Object-internal errors are a documented follow-up: instrumenting the
// DO needs it to extend the cloudflare:workers DurableObject base class.
export default Sentry.withSentry(
  (env: OnlineEnv) => ({
    dsn: env.SENTRY_DSN,
    environment: env.SENTRY_ENVIRONMENT,
    release: env.CHAMFER_RELEASE,
    enableLogs: true,
    tracesSampleRate: 0.1,
  }),
  { fetch: (request, env, ctx) => app.fetch(request, env as OnlineEnv, ctx) } as ExportedHandler<OnlineEnv>,
);
