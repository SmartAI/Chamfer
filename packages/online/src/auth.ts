import { betterAuth } from "better-auth";
import { Kysely } from "kysely";
import { D1Dialect } from "kysely-d1";
import type { OnlineEnv } from "./env";

/** better-auth instance over the shared D1 auth database. Social sign-in only:
 * no passwords to store, and Google/GitHub account creation is the bot
 * throttle for the demo (per-user token budgets bound the damage of any
 * automated sign-ups). Constructed per request — the Kysely wrapper is cheap
 * and Workers get fresh env bindings each invocation. */
export function createAuth(env: OnlineEnv, requestOrigin: string) {
  return betterAuth({
    database: {
      db: new Kysely({ dialect: new D1Dialect({ database: env.AUTH_DB }) }),
      type: "sqlite",
    },
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL ?? requestOrigin,
    basePath: "/api/auth",
    // The landing page signs users in on the apex and hands them to the app
    // subdomain, so the session cookie must span both and the app origin must
    // be an allowed redirect target.
    trustedOrigins: env.CHAMFER_TRUSTED_ORIGINS?.split(",").map((origin) => origin.trim()),
    ...(env.CHAMFER_COOKIE_DOMAIN
      ? {
          advanced: {
            crossSubDomainCookies: { enabled: true, domain: env.CHAMFER_COOKIE_DOMAIN },
          },
        }
      : {}),
    socialProviders: {
      ...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
        ? { google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } }
        : {}),
      ...(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
        ? { github: { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET } }
        : {}),
    },
  });
}
