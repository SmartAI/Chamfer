import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import { isLlmProvider, PROVIDER_DISPLAY_NAMES, type Provider } from "@chamfer/shared";
import { readEffectiveSettings } from "../../server/src/settingsStore";
import {
  DEMO_CAPACITY_MESSAGE,
  DEMO_QUOTA_EXHAUSTED_MESSAGE,
  NO_DEMO_KEY_MESSAGE,
  debitMicroUsd,
  ensureBudgetSchema,
  spentMicroUsd,
} from "./budget";
import { microUsdFromUsage } from "./demoPricing";
import type { GlobalDemoBudget } from "./globalDemoBudget";
import { verifyLlmToken } from "./llmToken";
import { cfAccessServiceTokenHeaders } from "./cfAccess";
import { CHAMFER_USER_ID_HEADER, type OnlineEnv } from "./env";

/** Container-facing LLM proxy (issues #48/#53, ADR 0003).
 *
 * The agent container reaches every LLM provider exclusively through this
 * route, so no provider key ever enters the machine that executes CAD code.
 *
 * Contract consumed by the container, one route per provider:
 * `https://<host>/api/llm/<provider>/<conversationId>` is handed to pi-ai as
 * the model's baseUrl. What each provider's SDK does with it (verified against
 * @earendil-works/pi-ai@0.81.1 source; re-verify on pi upgrades):
 *
 * - anthropic (api anthropic-messages, @anthropic-ai/sdk): provider default
 *   baseUrl is https://api.anthropic.com with NO version path - the SDK
 *   appends /v1/messages (and /v1/messages/count_tokens) itself, so the
 *   configured base must NOT end in /v1 and this route serves the /v1/*
 *   subtree. Credential: `x-api-key` header for API keys; the SDK switches to
 *   `Authorization: Bearer` only for keys it takes for OAuth tokens
 *   (containing "sk-ant-oat", which a conversation JWT never does).
 * - openai (api openai-responses for every model in pi-ai's openai registry,
 *   `openai` SDK): provider default baseUrl is https://api.openai.com/v1
 *   WITH the version path - the SDK appends only /responses to it
 *   (client.buildURL: new URL(baseURL + path)). The /v1 therefore lives in
 *   the proxy's upstream base here, never in the container-side base URL.
 *   Credential: `Authorization: Bearer` header.
 * - google (api google-generative-ai, @google/genai): provider default
 *   baseUrl is https://generativelanguage.googleapis.com/v1beta WITH the
 *   version path - pi-ai sets httpOptions.apiVersion = "" whenever a baseUrl
 *   is configured, so the SDK appends only /models/<id>:streamGenerateContent
 *   to it. The /v1beta lives in the proxy's upstream base, like openai's /v1.
 *   Credential: `x-goog-api-key` header; the Generative Language API also
 *   accepts a `?key=` query parameter, so the proxy strips that from every
 *   forwarded URL - a credential must never ride a query string upstream.
 *
 * Auth into the proxy: the short-lived conversation token minted by
 * llmToken.ts, passed as the SDK "API key" and therefore arriving in
 * whichever of the three credential slots above the provider SDK uses.
 *
 * The split mirrors the rest of the online architecture: the Worker gate
 * (llmProxyGate) authenticates and routes to the per-user Durable Object by
 * the token's user id claim; the DO route (llmProxyRoutes) resolves the real
 * per-provider key from the user's Settings and meters the demo budget in the
 * same SQLite tables as the chat path. The demo fallback exists ONLY for
 * anthropic and stays model-pinned and budget-metered; BYOK traffic on any
 * provider is unpinned and unmetered, exactly like the chat path.
 *
 * Neither half is mounted in createOnlineApp: the route-parity guard
 * (onlineRouteParity.test.ts) accounts for the browser client's route surface,
 * and this is deliberately not part of it - the browser never calls /api/llm.
 */

/** One conversation's proxy route prefix for a provider; the container-side
 * base URL is origin + this. The provider universe is the shared
 * LLM_PROVIDERS list (@chamfer/shared): one declaration serves this proxy,
 * the container config, and the client's composer gate. */
export function llmProxyPrefix(provider: Provider): string {
  return `/api/llm/${provider}`;
}

/** Route pattern both proxy halves serve; :provider is validated in the DO
 * route (the gate is deliberately provider-agnostic - token auth only). */
const LLM_PROXY_ROUTE = "/api/llm/:provider/:conversationId/*";

export const ANTHROPIC_UPSTREAM_URL = "https://api.anthropic.com";

interface ProviderWiring {
  /** Real upstream base the conversation subpath is appended to. Carries the
   * provider's version path exactly when its SDK does not append one itself -
   * see the per-provider notes in the module comment. */
  upstreamBase: string;
  injectAuth(headers: Headers, apiKey: string): void;
  /** Error body in the provider's native error shape, so the provider SDK
   * inside the container surfaces `message` into the turn's errorMessage. */
  errorBody(status: number, message: string): unknown;
}

const GOOGLE_STATUS_BY_CODE: Record<number, string> = {
  401: "UNAUTHENTICATED",
  403: "PERMISSION_DENIED",
  404: "NOT_FOUND",
  429: "RESOURCE_EXHAUSTED",
  503: "UNAVAILABLE",
};

function anthropicErrorType(status: number): string {
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_error";
  if (status === 429) return "rate_limit_error";
  if (status === 404) return "not_found_error";
  return "api_error";
}

export const PROVIDER_WIRING: Record<Provider, ProviderWiring> = {
  anthropic: {
    upstreamBase: ANTHROPIC_UPSTREAM_URL,
    injectAuth: (headers, apiKey) => headers.set("x-api-key", apiKey),
    errorBody: (status, message) => ({
      type: "error",
      error: { type: anthropicErrorType(status), message },
    }),
  },
  openai: {
    upstreamBase: "https://api.openai.com/v1",
    injectAuth: (headers, apiKey) => headers.set("authorization", `Bearer ${apiKey}`),
    errorBody: (_status, message) => ({
      error: { message, type: "invalid_request_error", param: null, code: null },
    }),
  },
  google: {
    upstreamBase: "https://generativelanguage.googleapis.com/v1beta",
    injectAuth: (headers, apiKey) => headers.set("x-goog-api-key", apiKey),
    errorBody: (status, message) => ({
      error: { code: status, message, status: GOOGLE_STATUS_BY_CODE[status] ?? "INTERNAL" },
    }),
  },
};

/** Every refusal drains the request stream first: workerd logs an uncaught
 * "can't read from request stream after response has been sent" error
 * otherwise, and refusals are routine (an expired token mid-turn most of
 * all). Forwarded requests never come through here - their body must stay
 * readable for the upstream fetch. */
async function refuse(
  request: Request,
  provider: Provider,
  status: 401 | 403 | 404 | 429 | 503,
  message: string,
): Promise<Response> {
  await request.arrayBuffer().catch(() => {});
  return new Response(JSON.stringify(PROVIDER_WIRING[provider].errorBody(status, message)), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** The conversation token travels in whichever credential slot the provider
 * SDK inside the container uses (see the module comment): `x-api-key`
 * (anthropic), `Authorization: Bearer` (openai, or an anthropic key the SDK
 * takes for OAuth), or `x-goog-api-key` (google). */
export function credentialFromHeaders(headers: Headers): string | undefined {
  const apiKey = headers.get("x-api-key") ?? headers.get("x-goog-api-key");
  if (apiKey) return apiKey;
  const authorization = headers.get("authorization");
  if (authorization?.startsWith("Bearer ")) return authorization.slice("Bearer ".length);
  return undefined;
}

/** Worker-side gate, mounted in worker.ts BEFORE the session middleware: the
 * container has no cookie jar, so this surface authenticates by conversation
 * token only. Everything invalid is a uniform 401; the token names the user,
 * and requests are routed to that user's Durable Object exactly like the
 * session-authenticated routes - never by anything else client-supplied. */
export function llmProxyGate(): Hono<{ Bindings: OnlineEnv }> {
  const app = new Hono<{ Bindings: OnlineEnv }>();
  app.all(LLM_PROXY_ROUTE, async (c) => {
    const secret = c.env.CHAMFER_LLM_TOKEN_SECRET;
    if (!secret) {
      return refuse(c.req.raw, "anthropic", 503, "The LLM proxy is not configured on this deployment.");
    }
    const token = credentialFromHeaders(c.req.raw.headers);
    const claims = token ? await verifyLlmToken(secret, token) : null;
    if (!claims || claims.conversationId !== c.req.param("conversationId")) {
      return refuse(c.req.raw, "anthropic", 401, "Invalid or expired conversation token.");
    }
    const namespace = c.env.USER_DO;
    const stub = namespace.get(namespace.idFromName(claims.userId));
    // This surface is reachable from inside the container, and the user-id
    // header is what the DO mints future tokens from: strip it so a hostile
    // prompt can never smuggle another user's id into its own DO.
    const forwarded = new Request(c.req.raw);
    forwarded.headers.delete(CHAMFER_USER_ID_HEADER);
    return stub.fetch(forwarded);
  });
  return app;
}

export interface LlmProxyConfig {
  /** Server-held demo key funding tokenless users (CHAMFER_DEMO_ANTHROPIC_KEY).
   * Anthropic-only: the demo fallback never applies to other providers. */
  demoApiKey?: string;
  /** Upstream override for demo traffic (CHAMFER_DEMO_ANTHROPIC_BASE_URL). */
  demoBaseUrl?: string;
  /** Cloudflare Access service token for the demo gateway behind demoBaseUrl;
   * presented only on demo traffic that uses demoBaseUrl, never on BYOK. */
  accessClientId?: string;
  accessClientSecret?: string;
  /** Per-account lifetime demo spend cap, in micro-USD (budget.ts). */
  lifetimeMicroUsd: number;
  /** The shared monthly demo spend ceiling across all users - the true cost
   * cap. Checked before a demo turn and debited after, alongside the per-account
   * cap, so the chat and agent surfaces share one accounting. */
  global: GlobalDemoBudget;
  /** Models demo traffic may name in its request body; anything else is
   * refused, because the budget meters tokens, not dollars, and the container
   * picks the model. Callers source this from DEMO_MODEL_ID in onlineApp.ts -
   * the same pin the chat path's default model uses. BYOK traffic is the
   * user's own bill and is never restricted. */
  allowedDemoModels: string[];
  /** Test seam; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/** The model named in a JSON request body; null when absent or unparseable. */
function requestedModel(body: ArrayBuffer): string | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as { model?: unknown };
    return typeof parsed.model === "string" ? parsed.model : null;
  } catch {
    return null;
  }
}

/** Hop-by-hop, routing, and auth headers that must not reach the upstream.
 * Everything else (anthropic-version, anthropic-beta, content-type, accept,
 * user-agent) passes through so the SDK inside the container keeps working. */
const STRIPPED_REQUEST_HEADERS = [
  "authorization",
  "x-api-key",
  "x-goog-api-key",
  // The proxy owns the Access service token; a hostile prompt inside the
  // container must never smuggle its own copy upstream.
  "cf-access-client-id",
  "cf-access-client-secret",
  "cookie",
  "host",
  "content-length",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "expect",
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "cf-worker",
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-real-ip",
];

/** Query parameters a credential could ride in (Google accepts `?key=`); the
 * proxy owns auth injection, so client-supplied copies never go upstream. */
const STRIPPED_QUERY_PARAMS = ["key", "access_token"];

/** Response headers are safelisted rather than blocklisted so upstream auth
 * material or cookies can never echo back to the container. */
const FORWARDED_RESPONSE_HEADERS = [
  "content-type",
  "cache-control",
  "retry-after",
  "request-id",
  "anthropic-request-id",
  "x-request-id",
];

interface UsageTally {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Last-non-null-wins per field, matching pi-ai's anthropic-messages tally so
 * the proxy debits the same totalTokens the chat path would for the same
 * stream (input + output + cacheRead + cacheWrite). Demo traffic is
 * anthropic-only, so only the Anthropic usage shape is ever metered. */
function applyUsage(tally: UsageTally, usage: unknown): void {
  if (typeof usage !== "object" || usage === null) return;
  const u = usage as Record<string, unknown>;
  if (typeof u.input_tokens === "number") tally.input = u.input_tokens;
  if (typeof u.output_tokens === "number") tally.output = u.output_tokens;
  if (typeof u.cache_read_input_tokens === "number") tally.cacheRead = u.cache_read_input_tokens;
  if (typeof u.cache_creation_input_tokens === "number") tally.cacheWrite = u.cache_creation_input_tokens;
}

/** Wraps the upstream SSE body in a pull-through stream that forwards each
 * chunk unmodified and immediately (one upstream read per downstream read, so
 * nothing buffers the whole response) while tallying usage from message_start
 * and message_delta events. Debits once, when the stream ends or the client
 * disconnects - the same "debit what was actually streamed" semantics as
 * budgetedLlm's finally block. The debit is handed the full per-category tally
 * so the demo cost can be priced exactly (demoPricing.ts). */
function meterSse(
  upstream: ReadableStream<Uint8Array>,
  debit: (usage: UsageTally) => void | Promise<void>,
): ReadableStream<Uint8Array> {
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  const tally: UsageTally = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let pending = "";
  let settled = false;
  const settle = async (): Promise<void> => {
    if (settled) return;
    settled = true;
    await debit(tally);
  };
  const scan = (text: string) => {
    pending += text;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      let event: unknown;
      try {
        event = JSON.parse(trimmed.slice("data:".length));
      } catch {
        continue;
      }
      const typed = event as { type?: string; message?: { usage?: unknown }; usage?: unknown };
      if (typed.type === "message_start") applyUsage(tally, typed.message?.usage);
      else if (typed.type === "message_delta") applyUsage(tally, typed.usage);
    }
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        await settle();
        controller.close();
        return;
      }
      scan(decoder.decode(value, { stream: true }));
      controller.enqueue(value);
    },
    async cancel(reason) {
      await settle();
      return reader.cancel(reason);
    },
  });
}

/** Durable-Object-side proxy: same key policy as the chat path (budgetedLlm) -
 * the user's Settings key for the request's provider first, unmetered;
 * otherwise (anthropic only) the server-held demo key, debited in dollars
 * against the same per-account lifetime and global monthly caps as the chat
 * path, so a user cannot double-spend by switching between the chat and agent
 * surfaces. A provider the user has no key for is
 * refused with a message naming the missing key - the transcript renders it. */
export function llmProxyRoutes(db: DatabaseSync, config: LlmProxyConfig): Hono {
  ensureBudgetSchema(db);
  const upstreamFetch = config.fetchImpl ?? fetch;
  const app = new Hono();

  app.all(LLM_PROXY_ROUTE, async (c) => {
    // Request bodies are bounded prompt JSON; buffering them first keeps the
    // fetch portable (streaming request bodies need duplex negotiation that
    // differs between workerd and Node) and consumes the stream before ANY
    // refusal below responds (workerd logs an error for unread request
    // streams). Response bodies stream - see meterSse.
    const method = c.req.method;
    const body = method === "GET" || method === "HEAD" ? undefined : await c.req.raw.arrayBuffer();

    const providerParam = c.req.param("provider");
    if (!isLlmProvider(providerParam)) {
      return refuse(c.req.raw, "anthropic", 404, `Unknown LLM provider route: ${providerParam}`);
    }
    const provider = providerParam;
    const wiring = PROVIDER_WIRING[provider];
    const url = new URL(c.req.url);
    const prefix = `${llmProxyPrefix(provider)}/${c.req.param("conversationId")}`;
    const subpath = url.pathname.slice(prefix.length) || "/";
    for (const name of STRIPPED_QUERY_PARAMS) url.searchParams.delete(name);

    // Same resolution the chat path uses in stream.ts: effective Settings
    // (per-user DO database) decide between BYOK and the demo key.
    const settings = readEffectiveSettings(db).settings;
    const userKey = settings[`${provider}ApiKey`];
    let apiKey: string;
    let upstreamBase: string;
    // The Access service token for the demo gateway tunnel. Stays undefined on
    // the BYOK branch: a user's own key routes to their own base URL, which is
    // never ours to present Min's token to.
    let accessHeaders: Record<string, string> | undefined;
    let debit: ((usage: UsageTally) => void | Promise<void>) | undefined;
    if (userKey) {
      apiKey = userKey;
      upstreamBase = settings[`${provider}BaseUrl`] || wiring.upstreamBase;
    } else if (provider === "anthropic") {
      if (!config.demoApiKey) {
        return refuse(c.req.raw, provider, 403, NO_DEMO_KEY_MESSAGE);
      }
      // Two caps, both dollar-denominated: this account's lifetime spend, then
      // the shared monthly pool. Checked before the turn; debited after.
      if (spentMicroUsd(db) >= config.lifetimeMicroUsd) {
        return refuse(c.req.raw, provider, 429, DEMO_QUOTA_EXHAUSTED_MESSAGE);
      }
      if (await config.global.isExhausted()) {
        return refuse(c.req.raw, provider, 429, DEMO_CAPACITY_MESSAGE);
      }
      apiKey = config.demoApiKey;
      upstreamBase = config.demoBaseUrl || wiring.upstreamBase;
      // Present the Access token only when the demo actually rides the gateway
      // tunnel (demoBaseUrl set); a demo pointing straight at api.anthropic.com
      // has no tunnel to authenticate to.
      if (config.demoBaseUrl) {
        accessHeaders = cfAccessServiceTokenHeaders(config.accessClientId, config.accessClientSecret);
      }
      debit = async (usage) => {
        const microUsd = microUsdFromUsage(usage);
        debitMicroUsd(db, microUsd);
        await config.global.spend(microUsd);
      };
    } else {
      const name = PROVIDER_DISPLAY_NAMES[provider];
      return refuse(
        c.req.raw,
        provider,
        403,
        `No ${name} API key is configured for this account. `
          + `Add your ${name} API key in Settings to run this model.`,
      );
    }

    const headers = new Headers(c.req.raw.headers);
    for (const name of STRIPPED_REQUEST_HEADERS) headers.delete(name);
    wiring.injectAuth(headers, apiKey);
    if (accessHeaders) {
      for (const [name, value] of Object.entries(accessHeaders)) headers.set(name, value);
    }

    // Demo traffic is pinned to the allowlisted demo model(s): the container
    // authors the request body, and an unpinned model choice would let a
    // hostile prompt burn the token budget at the priciest model. Bodyless
    // requests name no model and are already covered by usage metering.
    if (debit && body !== undefined && body.byteLength > 0) {
      const model = requestedModel(body);
      if (model === null || !config.allowedDemoModels.includes(model)) {
        return refuse(
          c.req.raw,
          provider,
          403,
          `The free demo quota covers ${config.allowedDemoModels.join(", ")} only. `
            + `To use ${model ?? "this model"}, add your own API key in Settings.`,
        );
      }
    }

    const query = url.searchParams.toString();
    const search = query ? `?${query}` : "";
    const upstream = await upstreamFetch(
      `${upstreamBase.replace(/\/+$/, "")}${subpath}${search}`,
      { method, headers, body },
    );

    const responseHeaders = new Headers();
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value !== null) responseHeaders.set(name, value);
    }
    const responseInit = { status: upstream.status, headers: responseHeaders };

    if (!debit || !upstream.ok || !upstream.body) {
      return new Response(upstream.body, responseInit);
    }
    const contentType = upstream.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream")) {
      return new Response(meterSse(upstream.body, debit), responseInit);
    }
    if (contentType.includes("application/json")) {
      const text = await upstream.text();
      const tally: UsageTally = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      try {
        applyUsage(tally, (JSON.parse(text) as { usage?: unknown }).usage);
      } catch {
        // Unparseable body: forward it anyway; there is no usage to debit.
      }
      await debit(tally);
      return new Response(text, responseInit);
    }
    return new Response(upstream.body, responseInit);
  });

  return app;
}
