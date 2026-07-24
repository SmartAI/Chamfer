import { beforeAll, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { llmProxyGate, llmProxyRoutes } from "./llmProxy";
import { mintLlmToken } from "./llmToken";
import { DEMO_CAPACITY_MESSAGE, DEMO_QUOTA_EXHAUSTED_MESSAGE, NO_DEMO_KEY_MESSAGE } from "./budget";
import type { GlobalDemoBudget } from "./globalDemoBudget";
import type { OnlineEnv } from "./env";

const GATE_SECRET = "gate-secret";
const NOW = Date.parse("2026-07-23T12:00:00Z");

// A generous per-account lifetime cap for the happy-path tests ($10 in micro-USD).
const LIFETIME = 10_000_000;
function openGlobal(): GlobalDemoBudget {
  return { isExhausted: async () => false, spend: async () => {} };
}
function exhaustedGlobal(): GlobalDemoBudget {
  return { isExhausted: async () => true, spend: async () => {} };
}

// Key resolution reads effective settings, whose env baseline would otherwise
// let the developer shell's real provider keys leak into these assertions.
beforeAll(() => {
  for (const name of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_BASE_URL",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "GOOGLE_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_BASE_URL",
  ]) {
    vi.stubEnv(name, "");
  }
});

// ---------------------------------------------------------------------------
// Worker-side gate: bearer-token auth in front of the per-user Durable Object.
// ---------------------------------------------------------------------------

function gateEnv(overrides: Partial<OnlineEnv> = {}): { env: OnlineEnv; reached: string[] } {
  const reached: string[] = [];
  const namespace = {
    idFromName: (name: string) => ({ toString: () => `do-for-${name}` }),
    get: (id: { toString(): string }) => ({
      fetch: async (request: Request) => {
        reached.push(`${id.toString()} ${new URL(request.url).pathname}`);
        return new Response("do-reply");
      },
    }),
  };
  const env = {
    CHAMFER_LLM_TOKEN_SECRET: GATE_SECRET,
    USER_DO: namespace,
    ...overrides,
  } as unknown as OnlineEnv;
  return { env, reached };
}

function messagesRequest(conversationId: string, token: string | undefined, header = "x-api-key") {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== undefined) {
    headers[header] = header === "authorization" ? `Bearer ${token}` : token;
  }
  return new Request(`https://app.example/api/llm/anthropic/${conversationId}/v1/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: "claude-test", stream: true }),
  });
}

describe("llmProxyGate", () => {
  it("routes a valid token to the Durable Object of the user it names", async () => {
    const { env, reached } = gateEnv();
    const token = await mintLlmToken(GATE_SECRET, { userId: "user-1", conversationId: "conv-1" });
    const response = await llmProxyGate().request(messagesRequest("conv-1", token), undefined, env);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("do-reply");
    expect(reached).toEqual(["do-for-user-1 /api/llm/anthropic/conv-1/v1/messages"]);
  });

  it("also accepts the token as an Authorization bearer", async () => {
    const { env, reached } = gateEnv();
    const token = await mintLlmToken(GATE_SECRET, { userId: "user-1", conversationId: "conv-1" });
    const response = await llmProxyGate().request(
      messagesRequest("conv-1", token, "authorization"),
      undefined,
      env,
    );
    expect(response.status).toBe(200);
    expect(reached).toHaveLength(1);
  });

  it("401s a missing token", async () => {
    const { env, reached } = gateEnv();
    const response = await llmProxyGate().request(messagesRequest("conv-1", undefined), undefined, env);
    expect(response.status).toBe(401);
    expect(reached).toEqual([]);
  });

  it("401s an expired token", async () => {
    const { env, reached } = gateEnv();
    const token = await mintLlmToken(
      GATE_SECRET,
      { userId: "user-1", conversationId: "conv-1", ttlSeconds: 60 },
      NOW - 120_000,
    );
    const response = await llmProxyGate().request(messagesRequest("conv-1", token), undefined, env);
    expect(response.status).toBe(401);
    expect(reached).toEqual([]);
  });

  it("401s garbled tokens", async () => {
    const { env, reached } = gateEnv();
    for (const garbage of ["junk", "e30.e30.AAAA", "a.b.c"]) {
      const response = await llmProxyGate().request(messagesRequest("conv-1", garbage), undefined, env);
      expect(response.status).toBe(401);
    }
    expect(reached).toEqual([]);
  });

  it("401s a token minted for another conversation", async () => {
    const { env, reached } = gateEnv();
    const token = await mintLlmToken(GATE_SECRET, { userId: "user-1", conversationId: "conv-1" });
    const response = await llmProxyGate().request(messagesRequest("conv-2", token), undefined, env);
    expect(response.status).toBe(401);
    expect(reached).toEqual([]);
  });

  it("503s when the deployment has no token secret", async () => {
    const { env, reached } = gateEnv({ CHAMFER_LLM_TOKEN_SECRET: undefined });
    const token = await mintLlmToken(GATE_SECRET, { userId: "user-1", conversationId: "conv-1" });
    const response = await llmProxyGate().request(messagesRequest("conv-1", token), undefined, env);
    expect(response.status).toBe(503);
    expect(reached).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// DO-side proxy: key resolution, dollar metering, streaming passthrough.
// ---------------------------------------------------------------------------

interface UpstreamCall {
  url: string;
  method: string;
  headers: Headers;
  body: string;
}

function sseBody(events: Array<{ event: string; data: unknown }>): string {
  return events.map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

const USAGE_SSE = sseBody([
  {
    event: "message_start",
    data: {
      type: "message_start",
      message: {
        id: "msg-1",
        usage: {
          input_tokens: 100,
          output_tokens: 1,
          cache_read_input_tokens: 25,
          cache_creation_input_tokens: 5,
        },
      },
    },
  },
  {
    event: "content_block_delta",
    data: { type: "content_block_delta", delta: { type: "text_delta", text: "hello" } },
  },
  {
    event: "message_delta",
    data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 50 } },
  },
  { event: "message_stop", data: { type: "message_stop" } },
]);

// The demo is priced exactly from the token breakdown (Sonnet 5 standard rates,
// micro-USD/token = dollars-per-million): input 100 * 3 + output 50 * 15 (last
// wins) + cacheRead 25 * 0.3 + cacheWrite 5 * 3.75 = 1076.25 -> 1076.
const USAGE_SSE_MICRO_USD = 1076;

function fakeUpstream(
  respond: (call: UpstreamCall) => Response,
): { calls: UpstreamCall[]; fetchImpl: typeof fetch } {
  const calls: UpstreamCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const call: UpstreamCall = {
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: await request.text(),
    };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function sseResponse(body: BodyInit | null, extraHeaders: Record<string, string> = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8", ...extraHeaders },
  });
}

function openDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  return db;
}

function setSetting(db: DatabaseSync, key: string, value: string): void {
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(key, value);
}

function seedSpend(db: DatabaseSync, microUsd: number): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS online_demo_spend (id INTEGER PRIMARY KEY CHECK (id = 1), micro_usd INTEGER NOT NULL)",
  );
  db.prepare("INSERT INTO online_demo_spend (id, micro_usd) VALUES (1, ?)").run(microUsd);
}

function spentMicroUsd(db: DatabaseSync): number | undefined {
  const row = db.prepare("SELECT micro_usd FROM online_demo_spend WHERE id = 1").get() as
    | { micro_usd: number }
    | undefined;
  return row?.micro_usd;
}

const ALLOWED_MODELS = ["claude-test"];

function proxyRequest(path = "/api/llm/anthropic/conv-1/v1/messages", model = "claude-test"): Request {
  return new Request(`https://do.internal${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": "the-container-token",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model, stream: true }),
  });
}

async function drainText(response: Response): Promise<string> {
  return await response.text();
}

describe("llmProxyRoutes", () => {
  it("forwards to the demo upstream with the demo key, never the container token", async () => {
    const db = openDb();
    const { calls, fetchImpl } = fakeUpstream(() => sseResponse(USAGE_SSE));
    const app = llmProxyRoutes(db, {
      demoApiKey: "demo-key",
      demoBaseUrl: "https://gateway.example.com",
      lifetimeMicroUsd: LIFETIME,
      allowedDemoModels: ALLOWED_MODELS,
      global: openGlobal(),
      fetchImpl,
    });

    const response = await app.request(proxyRequest("/api/llm/anthropic/conv-1/v1/messages?beta=true"));
    await drainText(response);

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("https://gateway.example.com/v1/messages?beta=true");
    expect(call.method).toBe("POST");
    expect(call.headers.get("x-api-key")).toBe("demo-key");
    expect(call.headers.get("authorization")).toBeNull();
    expect(call.headers.get("anthropic-version")).toBe("2023-06-01");
    expect(call.body).toBe(JSON.stringify({ model: "claude-test", stream: true }));
    for (const [name, value] of call.headers) {
      expect(`${name}: ${value}`).not.toContain("the-container-token");
    }
  });

  it("prefers the user's Settings key and passes it unmetered", async () => {
    const db = openDb();
    setSetting(db, "anthropicApiKey", "user-key");
    const { calls, fetchImpl } = fakeUpstream(() => sseResponse(USAGE_SSE));
    const app = llmProxyRoutes(db, {
      demoApiKey: "demo-key",
      lifetimeMicroUsd: LIFETIME,
      allowedDemoModels: ALLOWED_MODELS,
      global: openGlobal(),
      fetchImpl,
    });

    const response = await app.request(proxyRequest());
    await drainText(response);

    expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(calls[0]!.headers.get("x-api-key")).toBe("user-key");
    expect(spentMicroUsd(db)).toBeUndefined();
  });

  it("honors the user's Settings base URL for their own key", async () => {
    const db = openDb();
    setSetting(db, "anthropicApiKey", "user-key");
    setSetting(db, "anthropicBaseUrl", "https://byok-gateway.example.com");
    const { calls, fetchImpl } = fakeUpstream(() => sseResponse(USAGE_SSE));
    const app = llmProxyRoutes(db, {
      lifetimeMicroUsd: LIFETIME,
      allowedDemoModels: ALLOWED_MODELS,
      global: openGlobal(),
      fetchImpl,
    });

    await drainText(await app.request(proxyRequest()));

    expect(calls[0]!.url).toBe("https://byok-gateway.example.com/v1/messages");
  });

  it("presents the Access service token to the demo gateway and strips a smuggled copy", async () => {
    const db = openDb();
    const { calls, fetchImpl } = fakeUpstream(() => sseResponse(USAGE_SSE));
    const app = llmProxyRoutes(db, {
      demoApiKey: "demo-key",
      demoBaseUrl: "https://gateway.example.com",
      accessClientId: "cf-id",
      accessClientSecret: "cf-secret",
      lifetimeMicroUsd: LIFETIME,
      allowedDemoModels: ALLOWED_MODELS,
      global: openGlobal(),
      fetchImpl,
    });

    // A hostile prompt inside the container rides its own Access headers in;
    // the proxy owns the token, so its values must win, not be appended to.
    const request = new Request("https://do.internal/api/llm/anthropic/conv-1/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "the-container-token",
        "cf-access-client-id": "smuggled",
        "cf-access-client-secret": "smuggled",
      },
      body: JSON.stringify({ model: "claude-test", stream: true }),
    });
    await drainText(await app.request(request));

    const call = calls[0]!;
    expect(call.url).toBe("https://gateway.example.com/v1/messages");
    expect(call.headers.get("CF-Access-Client-Id")).toBe("cf-id");
    expect(call.headers.get("CF-Access-Client-Secret")).toBe("cf-secret");
    for (const [name, value] of call.headers) {
      expect(`${name}: ${value}`).not.toContain("smuggled");
    }
  });

  it("never presents the Access token on BYOK traffic", async () => {
    const db = openDb();
    setSetting(db, "anthropicApiKey", "user-key");
    const { calls, fetchImpl } = fakeUpstream(() => sseResponse(USAGE_SSE));
    const app = llmProxyRoutes(db, {
      demoApiKey: "demo-key",
      demoBaseUrl: "https://gateway.example.com",
      accessClientId: "cf-id",
      accessClientSecret: "cf-secret",
      lifetimeMicroUsd: LIFETIME,
      allowedDemoModels: ALLOWED_MODELS,
      global: openGlobal(),
      fetchImpl,
    });

    await drainText(await app.request(proxyRequest()));

    // BYOK routes to api.anthropic.com with the user's key; Min's Access token
    // is never presented to it.
    expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(calls[0]!.headers.get("x-api-key")).toBe("user-key");
    expect(calls[0]!.headers.get("CF-Access-Client-Id")).toBeNull();
    expect(calls[0]!.headers.get("CF-Access-Client-Secret")).toBeNull();
  });

  it("never echoes the resolved key or upstream auth headers to the client", async () => {
    const db = openDb();
    const { fetchImpl } = fakeUpstream(() =>
      sseResponse(USAGE_SSE, {
        "x-api-key": "demo-key",
        "authorization": "Bearer demo-key",
        "set-cookie": "upstream=1",
      }),
    );
    const app = llmProxyRoutes(db, {
      demoApiKey: "demo-key",
      lifetimeMicroUsd: LIFETIME,
      allowedDemoModels: ALLOWED_MODELS,
      global: openGlobal(),
      fetchImpl,
    });

    const response = await app.request(proxyRequest());
    const body = await drainText(response);

    expect(body).toBe(USAGE_SSE);
    expect(response.headers.get("x-api-key")).toBeNull();
    expect(response.headers.get("authorization")).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
    for (const [name, value] of response.headers) {
      expect(`${name}: ${value}`).not.toContain("demo-key");
    }
  });

  it("debits the demo spend in dollars from the streamed usage breakdown", async () => {
    const db = openDb();
    const spends: number[] = [];
    const global: GlobalDemoBudget = { isExhausted: async () => false, spend: async (m) => void spends.push(m) };
    const { fetchImpl } = fakeUpstream(() => sseResponse(USAGE_SSE));
    const app = llmProxyRoutes(db, {
      demoApiKey: "demo-key",
      lifetimeMicroUsd: LIFETIME,
      allowedDemoModels: ALLOWED_MODELS,
      global,
      fetchImpl,
    });

    await drainText(await app.request(proxyRequest()));

    expect(spentMicroUsd(db)).toBe(USAGE_SSE_MICRO_USD);
    // The global pool sees the identical debit, so surfaces cannot double-spend.
    expect(spends).toEqual([USAGE_SSE_MICRO_USD]);
  });

  it("debits non-streaming JSON responses too", async () => {
    const db = openDb();
    const { fetchImpl } = fakeUpstream(
      () =>
        new Response(
          JSON.stringify({ id: "msg-1", usage: { input_tokens: 10, output_tokens: 5 } }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const app = llmProxyRoutes(db, {
      demoApiKey: "demo-key",
      lifetimeMicroUsd: LIFETIME,
      allowedDemoModels: ALLOWED_MODELS,
      global: openGlobal(),
      fetchImpl,
    });

    const response = await app.request(proxyRequest());
    expect(JSON.parse(await drainText(response))).toMatchObject({ id: "msg-1" });
    // input 10 * 3 + output 5 * 15 = 105 micro-USD.
    expect(spentMicroUsd(db)).toBe(105);
  });

  it("refuses with the chat path's message once the per-account cap is spent", async () => {
    const db = openDb();
    const { calls, fetchImpl } = fakeUpstream(() => sseResponse(USAGE_SSE));
    seedSpend(db, 100);
    const app = llmProxyRoutes(db, {
      demoApiKey: "demo-key",
      lifetimeMicroUsd: 100,
      allowedDemoModels: ALLOWED_MODELS,
      global: openGlobal(),
      fetchImpl,
    });

    const response = await app.request(proxyRequest());

    expect(response.status).toBe(429);
    const payload = (await response.json()) as { error: { message: string } };
    expect(payload.error.message).toBe(DEMO_QUOTA_EXHAUSTED_MESSAGE);
    expect(calls).toEqual([]);
  });

  it("refuses with the capacity message once the global pool is exhausted", async () => {
    const db = openDb();
    const { calls, fetchImpl } = fakeUpstream(() => sseResponse(USAGE_SSE));
    const app = llmProxyRoutes(db, {
      demoApiKey: "demo-key",
      lifetimeMicroUsd: LIFETIME,
      allowedDemoModels: ALLOWED_MODELS,
      global: exhaustedGlobal(),
      fetchImpl,
    });

    const response = await app.request(proxyRequest());

    expect(response.status).toBe(429);
    const payload = (await response.json()) as { error: { message: string } };
    expect(payload.error.message).toBe(DEMO_CAPACITY_MESSAGE);
    expect(calls).toEqual([]);
    expect(spentMicroUsd(db)).toBeUndefined();
  });

  it("explains when no demo key is configured and the user has none", async () => {
    const db = openDb();
    const { calls, fetchImpl } = fakeUpstream(() => sseResponse(USAGE_SSE));
    const app = llmProxyRoutes(db, {
      lifetimeMicroUsd: LIFETIME,
      allowedDemoModels: ALLOWED_MODELS,
      global: openGlobal(),
      fetchImpl,
    });

    const response = await app.request(proxyRequest());

    expect(response.status).toBe(403);
    const payload = (await response.json()) as { error: { message: string } };
    expect(payload.error.message).toBe(NO_DEMO_KEY_MESSAGE);
    expect(calls).toEqual([]);
  });

  it("refuses demo traffic naming a model outside the demo allowlist", async () => {
    const db = openDb();
    const { calls, fetchImpl } = fakeUpstream(() => sseResponse(USAGE_SSE));
    const app = llmProxyRoutes(db, {
      demoApiKey: "demo-key",
      lifetimeMicroUsd: LIFETIME,
      allowedDemoModels: ALLOWED_MODELS,
      global: openGlobal(),
      fetchImpl,
    });

    const response = await app.request(
      proxyRequest("/api/llm/anthropic/conv-1/v1/messages", "claude-opus-pricey"),
    );

    expect(response.status).toBe(403);
    const payload = (await response.json()) as { error: { message: string } };
    expect(payload.error.message).toContain("claude-test");
    expect(payload.error.message).toContain("add your own API key in Settings");
    expect(calls).toEqual([]);
    expect(spentMicroUsd(db)).toBeUndefined();
  });

  it("refuses demo traffic whose body names no model at all", async () => {
    const db = openDb();
    const { calls, fetchImpl } = fakeUpstream(() => sseResponse(USAGE_SSE));
    const app = llmProxyRoutes(db, {
      demoApiKey: "demo-key",
      lifetimeMicroUsd: LIFETIME,
      allowedDemoModels: ALLOWED_MODELS,
      global: openGlobal(),
      fetchImpl,
    });

    const response = await app.request(
      new Request("https://do.internal/api/llm/anthropic/conv-1/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "the-container-token" },
        body: JSON.stringify({ stream: true }),
      }),
    );

    expect(response.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("lets BYOK traffic use any model", async () => {
    const db = openDb();
    setSetting(db, "anthropicApiKey", "user-key");
    const { calls, fetchImpl } = fakeUpstream(() => sseResponse(USAGE_SSE));
    const app = llmProxyRoutes(db, {
      demoApiKey: "demo-key",
      lifetimeMicroUsd: LIFETIME,
      allowedDemoModels: ALLOWED_MODELS,
      global: openGlobal(),
      fetchImpl,
    });

    const response = await app.request(
      proxyRequest("/api/llm/anthropic/conv-1/v1/messages", "claude-opus-pricey"),
    );
    await drainText(response);

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers.get("x-api-key")).toBe("user-key");
  });

  it("streams SSE through incrementally, not buffered", async () => {
    const db = openDb();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    const { fetchImpl } = fakeUpstream(() => sseResponse(upstreamBody));
    const app = llmProxyRoutes(db, {
      demoApiKey: "demo-key",
      lifetimeMicroUsd: LIFETIME,
      allowedDemoModels: ALLOWED_MODELS,
      global: openGlobal(),
      fetchImpl,
    });

    const response = await app.request(proxyRequest());
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();

    // First chunk arrives while the upstream stream is still open: nothing is
    // waiting for the full body.
    controller.enqueue(new TextEncoder().encode("event: message_start\ndata: {}\n\n"));
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(decoder.decode(first.value)).toContain("message_start");

    controller.enqueue(new TextEncoder().encode("event: message_stop\ndata: {}\n\n"));
    const second = await reader.read();
    expect(decoder.decode(second.value)).toContain("message_stop");

    controller.close();
    expect((await reader.read()).done).toBe(true);
  });

  it("passes upstream errors through without metering", async () => {
    const db = openDb();
    const { fetchImpl } = fakeUpstream(
      () =>
        new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error" } }), {
          status: 529,
          headers: { "content-type": "application/json" },
        }),
    );
    const app = llmProxyRoutes(db, {
      demoApiKey: "demo-key",
      lifetimeMicroUsd: LIFETIME,
      allowedDemoModels: ALLOWED_MODELS,
      global: openGlobal(),
      fetchImpl,
    });

    const response = await app.request(proxyRequest());

    expect(response.status).toBe(529);
    expect(spentMicroUsd(db)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Provider generalization (issue #53): per-provider path shape, auth
// injection, and key policy. The demo fallback stays anthropic-only.
// ---------------------------------------------------------------------------

describe("llmProxyRoutes multi-provider", () => {
  function routes(db: DatabaseSync, fetchImpl: typeof fetch, demoApiKey?: string) {
    return llmProxyRoutes(db, {
      demoApiKey,
      lifetimeMicroUsd: LIFETIME,
      allowedDemoModels: ALLOWED_MODELS,
      global: openGlobal(),
      fetchImpl,
    });
  }

  it("forwards openai BYOK to api.openai.com/v1 with a Bearer key (SDK appends only /responses)", async () => {
    const db = openDb();
    setSetting(db, "openaiApiKey", "sk-openai-user");
    const { calls, fetchImpl } = fakeUpstream(() => sseResponse(USAGE_SSE));

    const response = await routes(db, fetchImpl).request(
      new Request("https://do.internal/api/llm/openai/conv-1/responses", {
        method: "POST",
        headers: { "content-type": "application/json", "authorization": "Bearer the-container-token" },
        body: JSON.stringify({ model: "gpt-5.4-mini", stream: true }),
      }),
    );
    await drainText(response);

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.openai.com/v1/responses");
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer sk-openai-user");
    expect(calls[0]!.headers.get("x-api-key")).toBeNull();
    // BYOK is unmetered and unpinned, exactly like the anthropic chat path.
    expect(spentMicroUsd(db)).toBeUndefined();
  });

  it("forwards google BYOK to the /v1beta upstream via x-goog-api-key and strips a query-param key", async () => {
    const db = openDb();
    setSetting(db, "googleApiKey", "g-user-key");
    const { calls, fetchImpl } = fakeUpstream(() => sseResponse(USAGE_SSE));

    const response = await routes(db, fetchImpl).request(
      new Request(
        "https://do.internal/api/llm/google/conv-1/models/gemini-3.5-flash:streamGenerateContent?alt=sse&key=smuggled",
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": "the-container-token" },
          body: JSON.stringify({ contents: [] }),
        },
      ),
    );
    await drainText(response);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:streamGenerateContent?alt=sse",
    );
    expect(calls[0]!.headers.get("x-goog-api-key")).toBe("g-user-key");
    expect(calls[0]!.url).not.toContain("smuggled");
    for (const [name, value] of calls[0]!.headers) {
      expect(`${name}: ${value}`).not.toContain("the-container-token");
    }
    expect(spentMicroUsd(db)).toBeUndefined();
  });

  it("honors a per-provider Settings base URL", async () => {
    const db = openDb();
    setSetting(db, "openaiApiKey", "sk-openai-user");
    setSetting(db, "openaiBaseUrl", "https://openai-gateway.example.com/v1");
    const { calls, fetchImpl } = fakeUpstream(() => sseResponse(USAGE_SSE));

    await drainText(
      await routes(db, fetchImpl).request(
        new Request("https://do.internal/api/llm/openai/conv-1/responses", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        }),
      ),
    );

    expect(calls[0]!.url).toBe("https://openai-gateway.example.com/v1/responses");
  });

  it("refuses a provider the user has no key for, naming the missing key - no demo fallback", async () => {
    const db = openDb();
    const { calls, fetchImpl } = fakeUpstream(() => sseResponse(USAGE_SSE));
    // A configured demo key must not fund non-anthropic traffic.
    const app = routes(db, fetchImpl, "demo-key");

    const google = await app.request(
      new Request("https://do.internal/api/llm/google/conv-1/models/g:streamGenerateContent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(google.status).toBe(403);
    const googleBody = (await google.json()) as { error: { message: string; status: string } };
    expect(googleBody.error.message).toContain("Google API key");
    expect(googleBody.error.message).toContain("Settings");
    expect(googleBody.error.status).toBe("PERMISSION_DENIED");

    const openai = await app.request(
      new Request("https://do.internal/api/llm/openai/conv-1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(openai.status).toBe(403);
    const openaiBody = (await openai.json()) as { error: { message: string } };
    expect(openaiBody.error.message).toContain("OpenAI API key");
    expect(calls).toEqual([]);
  });

  it("404s an unknown provider segment", async () => {
    const db = openDb();
    const { calls, fetchImpl } = fakeUpstream(() => sseResponse(USAGE_SSE));
    const response = await routes(db, fetchImpl, "demo-key").request(
      new Request("https://do.internal/api/llm/mistral/conv-1/v1/chat", { method: "POST", body: "{}" }),
    );
    expect(response.status).toBe(404);
    expect(calls).toEqual([]);
  });
});

describe("llmProxyGate multi-provider", () => {
  it("routes any provider segment by token, reading the google credential header too", async () => {
    const { env, reached } = gateEnv();
    const token = await mintLlmToken(GATE_SECRET, { userId: "user-1", conversationId: "conv-1" });
    const response = await llmProxyGate().request(
      new Request("https://app.example/api/llm/google/conv-1/models/g:streamGenerateContent", {
        method: "POST",
        headers: { "x-goog-api-key": token },
        body: "{}",
      }),
      undefined,
      env,
    );
    expect(response.status).toBe(200);
    expect(reached).toEqual(["do-for-user-1 /api/llm/google/conv-1/models/g:streamGenerateContent"]);
  });

  it("401s tokenless requests on every provider route", async () => {
    const { env, reached } = gateEnv();
    for (const path of ["anthropic/conv-1/v1/messages", "openai/conv-1/responses", "google/conv-1/models/m:x"]) {
      const response = await llmProxyGate().request(
        new Request(`https://app.example/api/llm/${path}`, { method: "POST", body: "{}" }),
        undefined,
        env,
      );
      expect(response.status).toBe(401);
    }
    expect(reached).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Refusals drain the request stream (#53 review, finding 1): workerd logs an
// uncaught "can't read from request stream after response has been sent"
// error otherwise - and an expired token mid-turn is the most common refusal.
// Forwarded traffic must keep its body readable for the upstream fetch.
// ---------------------------------------------------------------------------

describe("refusals consume the request body", () => {
  function bodyRequest(url: string, headers: Record<string, string> = {}): Request {
    return new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ model: "claude-test", stream: true }),
    });
  }

  it("gate: every refusal path (missing, expired, garbled, cross-conversation token; no secret)", async () => {
    const expired = await mintLlmToken(
      GATE_SECRET,
      { userId: "user-1", conversationId: "conv-1", ttlSeconds: 60 },
      NOW - 120_000,
    );
    const crossConversation = await mintLlmToken(GATE_SECRET, { userId: "user-1", conversationId: "conv-2" });
    const cases: Array<{ name: string; headers: Record<string, string>; env: OnlineEnv; status: number }> = [
      { name: "missing token", headers: {}, env: gateEnv().env, status: 401 },
      { name: "expired token", headers: { "x-api-key": expired }, env: gateEnv().env, status: 401 },
      { name: "garbled token", headers: { "x-api-key": "a.b.c" }, env: gateEnv().env, status: 401 },
      { name: "cross-conversation token", headers: { "x-api-key": crossConversation }, env: gateEnv().env, status: 401 },
      {
        name: "no secret",
        headers: { "x-api-key": crossConversation },
        env: gateEnv({ CHAMFER_LLM_TOKEN_SECRET: undefined }).env,
        status: 503,
      },
    ];
    for (const testCase of cases) {
      const request = bodyRequest("https://app.example/api/llm/anthropic/conv-1/v1/messages", testCase.headers);
      const response = await llmProxyGate().request(request, undefined, testCase.env);
      expect(response.status, testCase.name).toBe(testCase.status);
      expect(request.bodyUsed, `${testCase.name}: body must be drained`).toBe(true);
    }
  });

  it("gate: a forwarded request keeps its body readable for the DO", async () => {
    const bodies: string[] = [];
    const namespace = {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (request: Request) => {
          bodies.push(await request.text());
          return new Response("do-reply");
        },
      }),
    };
    const env = { CHAMFER_LLM_TOKEN_SECRET: GATE_SECRET, USER_DO: namespace } as unknown as OnlineEnv;
    const token = await mintLlmToken(GATE_SECRET, { userId: "user-1", conversationId: "conv-1" });
    const response = await llmProxyGate().request(
      bodyRequest("https://app.example/api/llm/anthropic/conv-1/v1/messages", { "x-api-key": token }),
      undefined,
      env,
    );
    expect(response.status).toBe(200);
    expect(bodies).toEqual([JSON.stringify({ model: "claude-test", stream: true })]);
  });

  it("DO routes: every refusal path (unknown provider, no demo key, per-account cap, global cap, missing key, demo pin)", async () => {
    const spentDb = openDb();
    seedSpend(spentDb, 100);
    const cases: Array<{
      name: string;
      db: DatabaseSync;
      demoApiKey?: string;
      lifetimeMicroUsd?: number;
      global?: GlobalDemoBudget;
      url: string;
      model?: string;
      status: number;
    }> = [
      { name: "unknown provider", db: openDb(), demoApiKey: "demo-key", url: "https://do.internal/api/llm/mistral/conv-1/v1/chat", status: 404 },
      { name: "no demo key", db: openDb(), url: "https://do.internal/api/llm/anthropic/conv-1/v1/messages", status: 403 },
      { name: "per-account cap spent", db: spentDb, demoApiKey: "demo-key", lifetimeMicroUsd: 100, url: "https://do.internal/api/llm/anthropic/conv-1/v1/messages", status: 429 },
      { name: "global cap spent", db: openDb(), demoApiKey: "demo-key", global: exhaustedGlobal(), url: "https://do.internal/api/llm/anthropic/conv-1/v1/messages", status: 429 },
      { name: "missing provider key", db: openDb(), demoApiKey: "demo-key", url: "https://do.internal/api/llm/google/conv-1/models/m:x", status: 403 },
      { name: "demo model pin", db: openDb(), demoApiKey: "demo-key", url: "https://do.internal/api/llm/anthropic/conv-1/v1/messages", model: "claude-opus-pricey", status: 403 },
    ];
    for (const testCase of cases) {
      const { calls, fetchImpl } = fakeUpstream(() => sseResponse(USAGE_SSE));
      const app = llmProxyRoutes(testCase.db, {
        demoApiKey: testCase.demoApiKey,
        lifetimeMicroUsd: testCase.lifetimeMicroUsd ?? LIFETIME,
        allowedDemoModels: ALLOWED_MODELS,
        global: testCase.global ?? openGlobal(),
        fetchImpl,
      });
      const request = new Request(testCase.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: testCase.model ?? "claude-test", stream: true }),
      });
      const response = await app.request(request);
      expect(response.status, testCase.name).toBe(testCase.status);
      expect(request.bodyUsed, `${testCase.name}: body must be drained`).toBe(true);
      expect(calls, testCase.name).toEqual([]);
    }
  });
});
