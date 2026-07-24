/** Demo-traffic cost accounting, in integer micro-USD (1e-6 USD) to avoid the
 * float drift a running dollar total would accumulate over many small turns.
 *
 * The free demo is pinned to a single model (DEMO_MODEL_ID in onlineApp.ts), so
 * one price table is enough. We meter DOLLARS, not tokens: the metered token
 * mix blends output ($15/M) with cache reads ($0.30/M) - a 50x spread - so a
 * token cap would trip at an unpredictable real-dollar amount and could not
 * deliver the hard monthly ceiling the demo promises.
 *
 * Rates are Claude Sonnet 5 STANDARD list prices (not the introductory rates
 * that expire 2026-08-31), so a cap sized in dollars stays a ceiling after the
 * intro ends. Because a rate of $R per 1e6 tokens is R micro-USD per token, the
 * per-token micro-USD cost is exactly the dollars-per-million figure. Re-check
 * these if DEMO_MODEL_ID changes. */
const MICRO_USD_PER_TOKEN = {
  input: 3, // $3 / 1M
  output: 15, // $15 / 1M
  cacheRead: 0.3, // $0.30 / 1M (0.1x input)
  cacheWrite: 3.75, // $3.75 / 1M (1.25x input, 5-minute TTL)
} as const;

/** The per-category token counts the container-facing proxy tallies from an
 * Anthropic usage block (llmProxy.ts UsageTally). */
export interface DemoUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Exact micro-USD for a metered demo turn, from its per-category token counts.
 * The proxy path has this breakdown, so its cost is priced exactly. */
export function microUsdFromUsage(usage: DemoUsage): number {
  return Math.round(
    usage.input * MICRO_USD_PER_TOKEN.input +
      usage.output * MICRO_USD_PER_TOKEN.output +
      usage.cacheRead * MICRO_USD_PER_TOKEN.cacheRead +
      usage.cacheWrite * MICRO_USD_PER_TOKEN.cacheWrite,
  );
}

/** Conservative micro-USD when only a blended `totalTokens` is known (the chat
 * and title path exposes no per-category breakdown). Priced at the output
 * ceiling so this path can only ever over-count cost, never under-count it -
 * and its real demo traffic (title generation) is tiny. */
export function microUsdFromTotalTokens(totalTokens: number): number {
  return Math.round(totalTokens * MICRO_USD_PER_TOKEN.output);
}

/** Whole-dollar cap (from an env var) to the micro-USD used everywhere else. */
export function usdToMicroUsd(usd: number): number {
  return Math.round(usd * 1_000_000);
}
