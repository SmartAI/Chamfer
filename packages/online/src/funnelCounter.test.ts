import { describe, expect, it, vi } from "vitest";
import { makeFunnelCounter } from "./funnelCounter";

/** In-memory stand-in for the D1 auth database understanding the exact
 * statements funnelCounter issues: the CREATE, the idempotent
 * INSERT OR IGNORE keyed by (user_id, stage), and the per-stage COUNT. Keyed by
 * "userId::stage" so once-per-user idempotency comes from the set. */
function fakeFunnelD1(): D1Database & { rows: Set<string> } {
  const rows = new Set<string>();
  const key = (userId: string, stage: string): string => `${userId}::${stage}`;
  const db = {
    rows,
    async exec() {
      return { count: 0, duration: 0 };
    },
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          bound = args;
          return stmt;
        },
        async first<T>() {
          const stage = bound[0] as string;
          let n = 0;
          for (const entry of rows) if (entry.endsWith(`::${stage}`)) n += 1;
          return { n } as unknown as T;
        },
        async run() {
          if (/INSERT/i.test(sql)) {
            const [userId, stage] = bound as [string, string];
            rows.add(key(userId, stage));
          }
          return { success: true };
        },
      };
      return stmt;
    },
  } as unknown as D1Database & { rows: Set<string> };
  return db;
}

/** A D1 whose every statement throws, to prove the counter is fail-safe. */
function throwingD1(): D1Database {
  return {
    async exec() {
      throw new Error("d1 exec down");
    },
    prepare() {
      throw new Error("d1 prepare down");
    },
  } as unknown as D1Database;
}

describe("makeFunnelCounter", () => {
  it("counts a signup -> first turn -> artifact walk", async () => {
    const db = fakeFunnelD1();
    const funnel = makeFunnelCounter(db);

    expect(await funnel.summary()).toEqual({ signup: 0, firstTurn: 0, artifact: 0 });
    await funnel.record("signup", "user-1");
    await funnel.record("first_turn", "user-1");
    await funnel.record("artifact", "user-1");
    expect(await funnel.summary()).toEqual({ signup: 1, firstTurn: 1, artifact: 1 });
  });

  it("counts each stage once per user, however many times it is recorded", async () => {
    const db = fakeFunnelD1();
    const funnel = makeFunnelCounter(db);

    await funnel.record("signup", "user-1");
    await funnel.record("signup", "user-1");
    await funnel.record("first_turn", "user-1");
    await funnel.record("first_turn", "user-1");
    expect(await funnel.summary()).toEqual({ signup: 1, firstTurn: 1, artifact: 0 });
  });

  it("counts distinct users at each stage so funnel loss is visible", async () => {
    const db = fakeFunnelD1();
    const funnel = makeFunnelCounter(db);

    await funnel.record("signup", "user-1");
    await funnel.record("signup", "user-2");
    await funnel.record("first_turn", "user-1");
    // user-2 signed up but never took a turn: the drop is a 2 -> 1 -> 0 shape.
    expect(await funnel.summary()).toEqual({ signup: 2, firstTurn: 1, artifact: 0 });
  });

  it("swallows a DB failure on record so a counter can never break a turn", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const funnel = makeFunnelCounter(throwingD1());
    await expect(funnel.record("first_turn", "user-1")).resolves.toBeUndefined();
  });

  it("reports zeros rather than throwing when the summary read fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const funnel = makeFunnelCounter(throwingD1());
    expect(await funnel.summary()).toEqual({ signup: 0, firstTurn: 0, artifact: 0 });
  });

  it("is a no-op when no database is bound", async () => {
    const funnel = makeFunnelCounter(undefined);
    await expect(funnel.record("signup", "user-1")).resolves.toBeUndefined();
    expect(await funnel.summary()).toEqual({ signup: 0, firstTurn: 0, artifact: 0 });
  });
});
