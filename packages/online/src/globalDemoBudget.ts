/** The global monthly demo spend cap - the hard ceiling on what the free demo
 * can cost across ALL users in a calendar month. The per-user lifetime cap
 * (budget.ts) lives in each user's own Durable Object and cannot see the total;
 * this counter is the shared aggregate that actually bounds the bill.
 *
 * It lives in the D1 auth database (already bound as AUTH_DB), not a new Durable
 * Object: a new DO class would add a wrangler migration and hit the documented
 * `wrangler versions upload` DO-migration deploy trap. A single-row-per-month
 * table with an atomic `micro_usd = micro_usd + ?` increment is strongly
 * consistent enough - the only race is the pre-turn exhaustion check, whose
 * overshoot (in-flight turns) is already accepted. */

/** The UTC calendar month the demo budget resets on, `YYYY-MM`. Passed in from
 * callers rather than read here so the accounting is deterministic and
 * testable. */
export function utcMonth(now: Date = new Date()): string {
  return now.toISOString().slice(0, 7);
}

/** The slice of the D1 binding this module needs, declared structurally so the
 * module does not pull the whole Cloudflare type surface into every consumer -
 * the server's route-parity test compiles this file transitively and does not
 * load `@cloudflare/workers-types`. A real `D1Database` is structurally
 * assignable to this. */
interface D1Like {
  exec(query: string): Promise<unknown>;
  prepare(query: string): D1LikeStatement;
}
interface D1LikeStatement {
  bind(...values: unknown[]): D1LikeStatement;
  first<T>(): Promise<T | null>;
  run(): Promise<unknown>;
}

/** Fractions of the monthly cap worth alerting on: 80% (draining) and 100%
 * (exhausted). Shared so the write-time crossing log (spend, below) and the
 * cron probe's read-time level check (cronProbe.ts) never disagree on where
 * the lines are. Ascending. */
export const DEMO_BUDGET_ALERT_FRACTIONS = [0.8, 1] as const;

/** What the debit paths (budgetedLlm, llmProxyRoutes) consume: check before
 * starting a demo turn, debit its cost after. Both are async - a D1 round trip. */
export interface GlobalDemoBudget {
  /** True once this month's spend has reached the cap; demo turns are refused. */
  isExhausted(): Promise<boolean>;
  /** Add a turn's cost (micro-USD) to this month's total. No-op for <= 0. */
  spend(microUsd: number): Promise<void>;
  /** This UTC month's spend so far, micro-USD. The cron probe reads it to alert
   * on the cap being approached; 0 when no database is bound. */
  currentSpendMicroUsd(): Promise<number>;
}

/** Binds a GlobalDemoBudget to the D1 auth database.
 *
 * A missing database (defensive - AUTH_DB is always bound in wrangler.jsonc)
 * fails CLOSED: the cap cannot be enforced, so the demo is treated as
 * exhausted rather than spending unbounded. A D1 outage at runtime likewise
 * surfaces as a thrown error on the demo path (turn fails, safe on cost); BYOK
 * turns never reach here. */
export function makeGlobalDemoBudget(
  db: D1Like | undefined,
  monthlyMicroUsdCap: number,
): GlobalDemoBudget {
  if (!db) {
    return { isExhausted: async () => true, spend: async () => {}, currentSpendMicroUsd: async () => 0 };
  }

  let ensured = false;
  const ensureSchema = async (): Promise<void> => {
    if (ensured) return;
    await db.exec(
      "CREATE TABLE IF NOT EXISTS global_demo_spend (month TEXT PRIMARY KEY, micro_usd INTEGER NOT NULL)",
    );
    ensured = true;
  };

  const spentThisMonth = async (month: string): Promise<number> => {
    const row = await db
      .prepare("SELECT micro_usd FROM global_demo_spend WHERE month = ?")
      .bind(month)
      .first<{ micro_usd: number }>();
    return row?.micro_usd ?? 0;
  };

  return {
    async isExhausted() {
      await ensureSchema();
      return (await spentThisMonth(utcMonth())) >= monthlyMicroUsdCap;
    },

    async currentSpendMicroUsd() {
      await ensureSchema();
      return spentThisMonth(utcMonth());
    },

    async spend(microUsd) {
      if (microUsd <= 0) return;
      await ensureSchema();
      const month = utcMonth();
      await db
        .prepare(
          "INSERT INTO global_demo_spend (month, micro_usd) VALUES (?1, ?2) " +
            "ON CONFLICT(month) DO UPDATE SET micro_usd = micro_usd + ?2",
        )
        .bind(month, microUsd)
        .run();
      // Alert on crossing 80% and 100% of the cap so Min learns the demo is
      // draining without having to watch it. Best-effort and idempotent enough:
      // a rare duplicate log under concurrency is harmless. Workers Logs / Sentry
      // pick these up; increment 4's cron probe can key an alert on them.
      const after = await spentThisMonth(month);
      const before = after - microUsd;
      for (const fraction of DEMO_BUDGET_ALERT_FRACTIONS) {
        const threshold = monthlyMicroUsdCap * fraction;
        if (before < threshold && after >= threshold) {
          const pct = Math.round(fraction * 100);
          const cap = (monthlyMicroUsdCap / 1e6).toFixed(2);
          const spent = (after / 1e6).toFixed(2);
          console.error(
            `[demo-budget] month ${month} crossed ${pct}% of the $${cap} free-demo cap (spent $${spent})`,
          );
        }
      }
    },
  };
}
