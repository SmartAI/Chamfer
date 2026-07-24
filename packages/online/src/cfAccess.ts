/** Cloudflare Access service-token wiring for the self-hosted demo gateway.
 *
 * Kept in its own module - free of the ambient Cloudflare Workers types that
 * `env.ts` carries - because the chat path (`budget.ts`) imports this helper
 * and is transitively typechecked by the server package's route-parity test,
 * whose tsconfig has no `@cloudflare/workers-types`. Importing from `env.ts`
 * there would drag `Fetcher`/`D1Database`/etc. into that graph and fail. */

/** Cloudflare Access service-token header names. Both demo upstream paths (chat
 * via budget.ts, agent via llmProxy.ts) present these when the demo funding
 * gateway sits behind a `cloudflared` tunnel guarded by Cloudflare Access, so
 * the edge admits only this Worker to the tunnel and random internet traffic
 * never reaches the home box. */
export const CF_ACCESS_CLIENT_ID_HEADER = "CF-Access-Client-Id";
export const CF_ACCESS_CLIENT_SECRET_HEADER = "CF-Access-Client-Secret";

/** The Access service-token headers, or undefined when the deployment
 * configures no token (the demo base URL points straight at api.anthropic.com,
 * or the tunnel is protected by the gateway key alone). Deliberately attached
 * only to demo traffic on the configured gateway base URL - a user's own BYOK
 * base URL is never ours to present Min's token to. */
export function cfAccessServiceTokenHeaders(
  clientId: string | undefined,
  clientSecret: string | undefined,
): Record<string, string> | undefined {
  if (!clientId || !clientSecret) return undefined;
  return {
    [CF_ACCESS_CLIENT_ID_HEADER]: clientId,
    [CF_ACCESS_CLIENT_SECRET_HEADER]: clientSecret,
  };
}
