import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { budgetedLlm, DEMO_CAPACITY_MESSAGE } from "./budget";
import type { GlobalDemoBudget } from "./globalDemoBudget";
import type { LlmStreamer, PiEvent } from "../../server/src/llm";

function fakeInner(events: PiEvent[], calls: Array<Record<string, unknown>>): LlmStreamer {
  return {
    stream(model, _context, options) {
      calls.push({ model, options });
      return (async function* () {
        yield* events;
      })();
    },
  };
}

function doneEvent(totalTokens: number): PiEvent {
  return { type: "done", message: { usage: { totalTokens } } } as unknown as PiEvent;
}

async function drain(iterable: AsyncIterable<PiEvent>): Promise<PiEvent[]> {
  const seen: PiEvent[] = [];
  for await (const event of iterable) seen.push(event);
  return seen;
}

const ANTHROPIC_MODEL = { provider: "anthropic", id: "claude-test" };

/** An always-open global pool that records what each turn debited to it. */
function recordingGlobal(): GlobalDemoBudget & { spends: number[] } {
  const spends: number[] = [];
  return {
    spends,
    isExhausted: async () => false,
    spend: async (microUsd: number) => {
      spends.push(microUsd);
    },
  };
}

const EXHAUSTED_GLOBAL: GlobalDemoBudget = {
  isExhausted: async () => true,
  spend: async () => {},
};

function spent(db: DatabaseSync): number | undefined {
  const row = db.prepare("SELECT micro_usd FROM online_demo_spend WHERE id = 1").get() as
    | { micro_usd: number }
    | undefined;
  return row?.micro_usd;
}

// The chat path prices its blended totalTokens at the output ceiling ($15/M),
// i.e. 15 micro-USD per token.
const MICRO_USD_PER_CHAT_TOKEN = 15;

describe("budgetedLlm", () => {
  it("passes a user-provided key through untouched and unmetered", async () => {
    const db = new DatabaseSync(":memory:");
    const calls: Array<Record<string, unknown>> = [];
    const global = recordingGlobal();
    const llm = budgetedLlm(fakeInner([doneEvent(500)], calls), db, { apiKey: "demo", lifetimeMicroUsd: 1_000_000 }, global);

    await drain(llm.stream(ANTHROPIC_MODEL, {}, { apiKey: "user-key" }));

    expect((calls[0]!.options as { apiKey: string }).apiKey).toBe("user-key");
    expect(spent(db)).toBeUndefined();
    expect(global.spends).toEqual([]);
  });

  it("debits the demo spend, in dollars, from streamed usage", async () => {
    const db = new DatabaseSync(":memory:");
    const calls: Array<Record<string, unknown>> = [];
    const global = recordingGlobal();
    const llm = budgetedLlm(fakeInner([doneEvent(1234)], calls), db, { apiKey: "demo", lifetimeMicroUsd: 10_000_000 }, global);

    await drain(llm.stream(ANTHROPIC_MODEL, {}, {}));

    expect((calls[0]!.options as { apiKey: string }).apiKey).toBe("demo");
    const microUsd = 1234 * MICRO_USD_PER_CHAT_TOKEN;
    expect(spent(db)).toBe(microUsd);
    // Both the per-account and the global counters see the same debit.
    expect(global.spends).toEqual([microUsd]);
  });

  it("applies the demo base URL to the request model", async () => {
    const db = new DatabaseSync(":memory:");
    const calls: Array<Record<string, unknown>> = [];
    const llm = budgetedLlm(
      fakeInner([doneEvent(1)], calls),
      db,
      { apiKey: "demo", baseUrl: "https://gateway.example.com", lifetimeMicroUsd: 10_000_000 },
      recordingGlobal(),
    );

    await drain(llm.stream(ANTHROPIC_MODEL, {}, {}));

    expect((calls[0]!.model as { baseUrl: string }).baseUrl).toBe("https://gateway.example.com");
  });

  it("presents the Cloudflare Access service token on demo traffic to the gateway", async () => {
    const db = new DatabaseSync(":memory:");
    const calls: Array<Record<string, unknown>> = [];
    const llm = budgetedLlm(
      fakeInner([doneEvent(1)], calls),
      db,
      {
        apiKey: "demo",
        baseUrl: "https://gateway.example.com",
        accessClientId: "cf-id",
        accessClientSecret: "cf-secret",
        lifetimeMicroUsd: 10_000_000,
      },
      recordingGlobal(),
    );

    await drain(llm.stream(ANTHROPIC_MODEL, {}, {}));

    const model = calls[0]!.model as { baseUrl: string; headers: Record<string, string> };
    expect(model.baseUrl).toBe("https://gateway.example.com");
    expect(model.headers["CF-Access-Client-Id"]).toBe("cf-id");
    expect(model.headers["CF-Access-Client-Secret"]).toBe("cf-secret");
  });

  it("never overrides a user's own key with the gateway base URL or Access token", async () => {
    const db = new DatabaseSync(":memory:");
    const calls: Array<Record<string, unknown>> = [];
    const llm = budgetedLlm(
      fakeInner([doneEvent(1)], calls),
      db,
      {
        apiKey: "demo",
        baseUrl: "https://gateway.example.com",
        accessClientId: "cf-id",
        accessClientSecret: "cf-secret",
        lifetimeMicroUsd: 10_000_000,
      },
      recordingGlobal(),
    );

    // BYOK: the user configured their own key. It must reach the provider
    // untouched - no gateway base URL, no Access token, no metering.
    await drain(llm.stream(ANTHROPIC_MODEL, {}, { apiKey: "user-key" }));

    expect((calls[0]!.options as { apiKey: string }).apiKey).toBe("user-key");
    expect(calls[0]!.model).toEqual(ANTHROPIC_MODEL);
    expect(spent(db)).toBeUndefined();
  });

  it("refuses once the per-account lifetime cap is spent", async () => {
    const db = new DatabaseSync(":memory:");
    const calls: Array<Record<string, unknown>> = [];
    // doneEvent(60) costs 60 * 15 = 900 micro-USD, past the 500 cap.
    const llm = budgetedLlm(fakeInner([doneEvent(60)], calls), db, { apiKey: "demo", lifetimeMicroUsd: 500 }, recordingGlobal());

    await drain(llm.stream(ANTHROPIC_MODEL, {}, {}));
    expect(() => llm.stream(ANTHROPIC_MODEL, {}, {})).toThrow(/free demo quota/);
    expect(calls).toHaveLength(1);
  });

  it("refuses with the capacity message when the global pool is exhausted", async () => {
    const db = new DatabaseSync(":memory:");
    const calls: Array<Record<string, unknown>> = [];
    const llm = budgetedLlm(fakeInner([doneEvent(10)], calls), db, { apiKey: "demo", lifetimeMicroUsd: 10_000_000 }, EXHAUSTED_GLOBAL);

    // The global check runs inside the stream, so it surfaces as a rejection.
    await expect(drain(llm.stream(ANTHROPIC_MODEL, {}, {}))).rejects.toThrow(DEMO_CAPACITY_MESSAGE);
    // The upstream request never started, and nothing was debited.
    expect(calls).toEqual([]);
    expect(spent(db)).toBeUndefined();
  });

  it("refuses non-Anthropic providers on the demo key", () => {
    const db = new DatabaseSync(":memory:");
    const llm = budgetedLlm(fakeInner([], []), db, { apiKey: "demo", lifetimeMicroUsd: 500 }, recordingGlobal());

    expect(() => llm.stream({ provider: "openai", id: "gpt-test" }, {}, {})).toThrow(/Anthropic models only/);
  });

  it("explains when no demo key is configured", () => {
    const db = new DatabaseSync(":memory:");
    const llm = budgetedLlm(fakeInner([], []), db, { lifetimeMicroUsd: 500 }, recordingGlobal());

    expect(() => llm.stream(ANTHROPIC_MODEL, {}, {})).toThrow(/Add your Anthropic API key/);
  });
});
