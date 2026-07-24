import { describe, expect, it, vi } from "vitest";
import { makeGlobalDemoBudget, utcMonth } from "./globalDemoBudget";

/** A minimal in-memory stand-in for the D1 auth database that understands the
 * exact statements globalDemoBudget issues: the CREATE, the per-month SELECT,
 * and the accumulating INSERT ... ON CONFLICT. Keyed by month. */
function fakeD1(): D1Database & { store: Map<string, number> } {
  const store = new Map<string, number>();
  const db = {
    store,
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
          const month = bound[0] as string;
          const value = store.get(month);
          return (value === undefined ? null : ({ micro_usd: value } as unknown)) as T | null;
        },
        async run() {
          if (sql.includes("INSERT")) {
            const month = bound[0] as string;
            const add = bound[1] as number;
            store.set(month, (store.get(month) ?? 0) + add);
          }
          return { success: true };
        },
      };
      return stmt;
    },
  } as unknown as D1Database & { store: Map<string, number> };
  return db;
}

describe("utcMonth", () => {
  it("keys by UTC calendar month", () => {
    expect(utcMonth(new Date("2026-07-24T23:30:00Z"))).toBe("2026-07");
    expect(utcMonth(new Date("2026-08-01T00:00:00Z"))).toBe("2026-08");
  });
});

describe("makeGlobalDemoBudget", () => {
  it("accumulates spend across turns and trips at the cap", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const db = fakeD1();
    const budget = makeGlobalDemoBudget(db, 1000);

    expect(await budget.isExhausted()).toBe(false);
    await budget.spend(400);
    await budget.spend(400);
    expect(await budget.isExhausted()).toBe(false); // 800 < 1000
    await budget.spend(300);
    expect(await budget.isExhausted()).toBe(true); // 1100 >= 1000
  });

  it("ignores non-positive spend", async () => {
    const db = fakeD1();
    const budget = makeGlobalDemoBudget(db, 1000);
    await budget.spend(0);
    await budget.spend(-5);
    expect(db.store.size).toBe(0);
    expect(await budget.isExhausted()).toBe(false);
  });

  it("fails closed when no database is bound", async () => {
    const budget = makeGlobalDemoBudget(undefined, 1000);
    expect(await budget.isExhausted()).toBe(true);
    await expect(budget.spend(100)).resolves.toBeUndefined();
  });
});
