import type { DatabaseSync } from "node:sqlite";
import type { LlmStreamer, PiEvent } from "../../server/src/llm";
import type { GlobalDemoBudget } from "./globalDemoBudget";
import { microUsdFromTotalTokens } from "./demoPricing";
import { cfAccessServiceTokenHeaders } from "./cfAccess";

export interface DemoKeyConfig {
  apiKey?: string;
  baseUrl?: string;
  /** Cloudflare Access service token for the gateway behind `baseUrl`; presented
   * only when both `baseUrl` and the token are set. See env.ts. */
  accessClientId?: string;
  accessClientSecret?: string;
  /** Per-account LIFETIME demo spend cap, in micro-USD (1e-6 USD). Once an
   * account has spent this much on the demo key it falls back to BYOK - the
   * demo is a one-time taste, not a renewing allowance. */
  lifetimeMicroUsd: number;
}

/** Whole-dollar defaults, converted to micro-USD by the caller (userDo.ts). */
export const DEFAULT_DEMO_LIFETIME_USD = 2;
export const DEFAULT_DEMO_MONTHLY_USD = 50;

/** Refusal wordings shared verbatim by the chat path (budgetedLlm) and the
 * container-facing LLM proxy (llmProxy.ts), so both surfaces fail the same way
 * for the same reason. */
export const NO_DEMO_KEY_MESSAGE =
  "This deployment has no shared demo key. Add your Anthropic API key in Settings to start designing.";
/** The account has spent its one-time lifetime quota. No reset - the fix is a
 * personal key. */
export const DEMO_QUOTA_EXHAUSTED_MESSAGE =
  "You've used up your free demo quota. Add your own Anthropic API key in Settings to keep designing.";
/** The global monthly pool is spent, so the demo is off for everyone until the
 * month rolls over. Distinct from the per-account message: nothing the user did
 * is wrong, so it points at BYOK now or a reset later. */
export const DEMO_CAPACITY_MESSAGE =
  "The free demo is at capacity for now. Add your own Anthropic API key in Settings to keep designing, or check back next month.";

export function ensureBudgetSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS online_demo_spend (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      micro_usd INTEGER NOT NULL
    );
  `);
}

/** This account's lifetime demo spend, in micro-USD. */
export function spentMicroUsd(db: DatabaseSync): number {
  const row = db.prepare("SELECT micro_usd FROM online_demo_spend WHERE id = 1").get() as
    | { micro_usd: number }
    | undefined;
  return row?.micro_usd ?? 0;
}

export function debitMicroUsd(db: DatabaseSync, microUsd: number): void {
  if (microUsd <= 0) return;
  db.prepare(
    `INSERT INTO online_demo_spend (id, micro_usd) VALUES (1, ?)
     ON CONFLICT(id) DO UPDATE SET micro_usd = micro_usd + excluded.micro_usd`,
  ).run(microUsd);
}

function eventTokens(event: PiEvent): number {
  const usage = (event as { message?: { usage?: { totalTokens?: number } } }).message?.usage
    ?? (event as { usage?: { totalTokens?: number } }).usage;
  return usage?.totalTokens ?? 0;
}

/** Wraps the LLM streamer with the online payment model.
 *
 * Calls that already carry an apiKey (the user configured their own key in
 * Settings) pass through untouched and unmetered. Calls without one fall back
 * to the server-held demo key - Anthropic only - and are metered in dollars
 * against two caps: this account's lifetime spend (the user's own Durable
 * Object database) and the global monthly pool (shared, the true ceiling).
 * Both must have room before a turn starts, and both are debited after it,
 * so switching between the chat and agent surfaces cannot dodge a cap or
 * double-spend. This blended `totalTokens` path is priced conservatively at the
 * output rate; the proxy path (llmProxy.ts) prices its exact token breakdown.
 */
export function budgetedLlm(
  inner: LlmStreamer,
  db: DatabaseSync,
  config: DemoKeyConfig,
  global: GlobalDemoBudget,
): LlmStreamer {
  ensureBudgetSchema(db);

  return {
    stream(model, context, options): AsyncIterable<PiEvent> {
      if (options.apiKey) return inner.stream(model, context, options);

      const provider = (model as { provider?: string } | null)?.provider;
      if (!config.apiKey) {
        throw new Error(NO_DEMO_KEY_MESSAGE);
      }
      if (provider !== "anthropic") {
        throw new Error(
          `The free demo quota covers Anthropic models only. To use ${provider ?? "this provider"}, add your own API key in Settings.`,
        );
      }
      if (spentMicroUsd(db) >= config.lifetimeMicroUsd) {
        throw new Error(DEMO_QUOTA_EXHAUSTED_MESSAGE);
      }

      // Route demo traffic through the configured gateway base URL, presenting
      // the Access service token when the tunnel guards itself with one. The
      // token rides the gateway base URL only - never the real Anthropic API.
      const accessHeaders = cfAccessServiceTokenHeaders(config.accessClientId, config.accessClientSecret);
      const requestModel = config.baseUrl && typeof model === "object" && model !== null
        ? {
            ...model,
            baseUrl: config.baseUrl,
            ...(accessHeaders
              ? { headers: { ...(model as { headers?: Record<string, string> }).headers, ...accessHeaders } }
              : {}),
          }
        : model;
      const apiKey = config.apiKey;
      return (async function* () {
        // The global check is a D1 round trip, so it can only run in the async
        // context here (the per-account check above is synchronous and local).
        if (await global.isExhausted()) {
          throw new Error(DEMO_CAPACITY_MESSAGE);
        }
        const streamed = inner.stream(requestModel, context, { ...options, apiKey });
        let total = 0;
        try {
          for await (const event of streamed) {
            if (event.type === "done" || event.type === "error") total += eventTokens(event);
            yield event;
          }
        } finally {
          const microUsd = microUsdFromTotalTokens(total);
          debitMicroUsd(db, microUsd);
          await global.spend(microUsd);
        }
      })();
    },
  };
}
