/** The trial-funnel counter (#73): how many users cross each stage of the
 * hosted trial - signup -> first hosted turn -> first artifact - so funnel loss
 * is visible instead of invisible. Deferred by #40 ("file when reached").
 *
 * Like globalDemoBudget, it lives in the shared D1 auth database (already bound
 * as AUTH_DB), not a new Durable Object: a new DO class would add a wrangler
 * migration and hit the documented DO-migration deploy trap. The table is one
 * row per (user, stage), so counting a stage twice for the same user is a
 * no-op - the increment sites need not know whether it is a user's first turn,
 * the primary key makes "first" true by construction. Every stage count is a
 * COUNT over that stage's rows.
 *
 * FAIL-SAFE, unconditionally: the counter is observability, never a gate. A D1
 * outage on the write path must never break a signup or a turn, and a read
 * failure must never 503 the health endpoint - both swallow and degrade to a
 * logged no-op / zeros. This is the deliberate difference from globalDemoBudget,
 * which fails CLOSED because it bounds real spend. */

/** The slice of the D1 binding this module needs, declared structurally so it
 * does not pull the whole Cloudflare type surface into every consumer - the
 * server's route-parity test compiles this file transitively (via onlineApp)
 * and does not load `@cloudflare/workers-types`. A real `D1Database` is
 * structurally assignable to this. */
interface D1Like {
  exec(query: string): Promise<unknown>;
  prepare(query: string): D1LikeStatement;
}
interface D1LikeStatement {
  bind(...values: unknown[]): D1LikeStatement;
  first<T>(): Promise<T | null>;
  run(): Promise<unknown>;
}

/** The trial stages, in funnel order. Stored verbatim as the `stage` column. */
export type FunnelStage = "signup" | "first_turn" | "artifact";

/** Distinct users who have crossed each stage this deployment's lifetime. */
export interface FunnelSummary {
  signup: number;
  firstTurn: number;
  artifact: number;
}

/** Records funnel crossings and reads the aggregate. Reads live behind the
 * health endpoint and the cron probe; writes fire from the signup hook and the
 * turn host. */
export interface FunnelCounter {
  /** Note that `userId` crossed `stage`. Idempotent per (user, stage) and
   * best-effort: a failure is logged and swallowed, never thrown. */
  record(stage: FunnelStage, userId: string): Promise<void>;
  /** The current per-stage counts. Zeros on any read failure. */
  summary(): Promise<FunnelSummary>;
}

const EMPTY: FunnelSummary = { signup: 0, firstTurn: 0, artifact: 0 };

/** Binds a FunnelCounter to the D1 auth database. A missing database (defensive
 * - AUTH_DB is always bound in wrangler.jsonc) is an inert no-op counter. */
export function makeFunnelCounter(db: D1Like | undefined): FunnelCounter {
  if (!db) {
    return { record: async () => {}, summary: async () => ({ ...EMPTY }) };
  }

  let ensured = false;
  const ensureSchema = async (): Promise<void> => {
    if (ensured) return;
    await db.exec(
      "CREATE TABLE IF NOT EXISTS funnel_events "
        + "(user_id TEXT NOT NULL, stage TEXT NOT NULL, at INTEGER NOT NULL, "
        + "PRIMARY KEY (user_id, stage))",
    );
    ensured = true;
  };

  const countStage = async (stage: FunnelStage): Promise<number> => {
    const row = await db
      .prepare("SELECT COUNT(*) AS n FROM funnel_events WHERE stage = ?1")
      .bind(stage)
      .first<{ n: number }>();
    return row?.n ?? 0;
  };

  return {
    async record(stage, userId) {
      try {
        await ensureSchema();
        await db
          .prepare("INSERT OR IGNORE INTO funnel_events (user_id, stage, at) VALUES (?1, ?2, ?3)")
          .bind(userId, stage, Date.now())
          .run();
      } catch (error) {
        console.error(
          `[funnel] failed to record ${stage} for a user: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },

    async summary() {
      try {
        await ensureSchema();
        const [signup, firstTurn, artifact] = await Promise.all([
          countStage("signup"),
          countStage("first_turn"),
          countStage("artifact"),
        ]);
        return { signup, firstTurn, artifact };
      } catch (error) {
        console.error(
          `[funnel] failed to read the funnel summary: ${error instanceof Error ? error.message : String(error)}`,
        );
        return { ...EMPTY };
      }
    },
  };
}
