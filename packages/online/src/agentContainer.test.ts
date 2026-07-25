import { describe, expect, it } from "vitest";
import {
  AGENT_CONTAINER_BOOT_TOKEN,
  agentContainerBootEnv,
  agentContainerName,
  agentContainerProxyBaseUrl,
  agentContainerRoutes,
} from "./agentContainer";
import { DEMO_MODEL_ID } from "./onlineApp";

describe("agentContainerBootEnv", () => {
  it("boots production containers against the deployment's own origin", () => {
    const env = agentContainerBootEnv({ CHAMFER_APP_ORIGIN: "https://app.chamferonline.com" });
    expect(env).toEqual({
      CHAMFER_LLM_BASE_URL: "https://app.chamferonline.com",
      CHAMFER_LLM_TOKEN: AGENT_CONTAINER_BOOT_TOKEN,
      CHAMFER_MODEL: DEMO_MODEL_ID,
      CHAMFER_PROVIDER: "anthropic",
    });
  });

  it("prefers the dev override origin reachable from inside Docker", () => {
    const env = agentContainerBootEnv({
      CHAMFER_APP_ORIGIN: "https://app.chamferonline.com",
      CHAMFER_CONTAINER_LLM_ORIGIN: "http://host.docker.internal:8793",
    });
    expect(env.CHAMFER_LLM_BASE_URL).toBe("http://host.docker.internal:8793");
  });

  it("refuses to assemble an env with no proxy origin", () => {
    expect(() => agentContainerBootEnv({})).toThrow(/CHAMFER_APP_ORIGIN/);
  });

  it("passes a raised CAD-run cap through so the container enforces what the TTL was sized for", () => {
    const base = { CHAMFER_APP_ORIGIN: "https://app.chamferonline.com" };
    expect(agentContainerBootEnv(base).CHAMFER_MAX_CAD_RUNS).toBeUndefined();
    expect(agentContainerBootEnv({ ...base, CHAMFER_MAX_CAD_RUNS: "25" }).CHAMFER_MAX_CAD_RUNS).toBe("25");
  });

  it("never carries a provider credential, whatever OnlineEnv holds (#40 custody rule)", () => {
    const poisoned = {
      CHAMFER_APP_ORIGIN: "https://app.chamferonline.com",
      CHAMFER_DEMO_ANTHROPIC_KEY: "sk-ant-demo-secret",
      CHAMFER_LLM_TOKEN_SECRET: "signing-secret",
      BETTER_AUTH_SECRET: "auth-secret",
      ANTHROPIC_API_KEY: "sk-ant-shell-leak",
    };
    const env = agentContainerBootEnv(poisoned);
    expect(Object.keys(env).sort()).toEqual([
      "CHAMFER_LLM_BASE_URL",
      "CHAMFER_LLM_TOKEN",
      "CHAMFER_MODEL",
      "CHAMFER_PROVIDER",
    ]);
    expect(JSON.stringify(env)).not.toMatch(/secret|sk-ant/);
  });
});

describe("agentContainerProxyBaseUrl", () => {
  it("builds each provider's conversation route, bare of any version path", () => {
    const env = { CHAMFER_APP_ORIGIN: "https://app.chamferonline.com/" };
    expect(agentContainerProxyBaseUrl(env, "anthropic", "conv-1")).toBe(
      "https://app.chamferonline.com/api/llm/anthropic/conv-1",
    );
    expect(agentContainerProxyBaseUrl(env, "openai", "conv-1")).toBe(
      "https://app.chamferonline.com/api/llm/openai/conv-1",
    );
    expect(agentContainerProxyBaseUrl(env, "google", "conv-1")).toBe(
      "https://app.chamferonline.com/api/llm/google/conv-1",
    );
  });

  it("throws without a container-reachable origin", () => {
    expect(() => agentContainerProxyBaseUrl({}, "anthropic", "conv-1")).toThrow(/CHAMFER_APP_ORIGIN/);
  });
});

describe("agentContainerName", () => {
  it("derives deterministically from the user DO id and nothing else", () => {
    expect(agentContainerName("abc123")).toBe(agentContainerName("abc123"));
    expect(agentContainerName("abc123")).not.toBe(agentContainerName("def456"));
    expect(agentContainerName("abc123")).toContain("abc123");
  });
});

interface FakeNamespaceCalls {
  namedIds: string[];
  requests: string[];
}

function fakeNamespace(
  handler: () => Promise<Response> | Response,
): { namespace: DurableObjectNamespace; calls: FakeNamespaceCalls } {
  const calls: FakeNamespaceCalls = { namedIds: [], requests: [] };
  const namespace = {
    idFromName: (name: string) => {
      calls.namedIds.push(name);
      return name as unknown as DurableObjectId;
    },
    get: () => ({
      fetch: async (input: RequestInfo | URL) => {
        calls.requests.push(String(input));
        return handler();
      },
    }),
  } as unknown as DurableObjectNamespace;
  return { namespace, calls };
}

describe("agentContainerRoutes probe", () => {
  const probe = (app: ReturnType<typeof agentContainerRoutes>) =>
    app.request("/api/online/agent-container/health");

  it("reports an unconfigured deployment cleanly with 503", async () => {
    const response = await probe(agentContainerRoutes(undefined, "user:1"));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, configured: false });
  });

  it("wakes the named container and reports ok with the wake latency", async () => {
    const { namespace, calls } = fakeNamespace(() => Response.json({ ok: true }));
    const response = await probe(agentContainerRoutes(namespace, "user:do-id-1"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; configured: boolean; wakeMs: number };
    expect(body.ok).toBe(true);
    expect(body.configured).toBe(true);
    expect(body.wakeMs).toBeGreaterThanOrEqual(0);
    expect(calls.namedIds).toEqual(["user:do-id-1"]);
    expect(calls.requests[0]).toContain("/api/health");
  });

  it("answers 502 when the container's health is not ok", async () => {
    const { namespace } = fakeNamespace(() => Response.json({ ok: false }, { status: 500 }));
    const response = await probe(agentContainerRoutes(namespace, "user:1"));
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ ok: false, configured: true, status: 500 });
  });

  it("answers 502 with the error when the container path throws instead of crashing the DO", async () => {
    const { namespace } = fakeNamespace(() => {
      throw new Error("there is no container instance");
    });
    const response = await probe(agentContainerRoutes(namespace, "user:1"));
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      ok: false,
      configured: true,
      error: "there is no container instance",
    });
  });

  // Version handshake (issue #56): the probe surfaces the same comparison the
  // turn host refuses on, as a monitoring read.
  describe("version handshake", () => {
    it("reports ok with both versions when the running image matches", async () => {
      const { namespace } = fakeNamespace(() => Response.json({ ok: true, version: "img-7" }));
      const response = await probe(agentContainerRoutes(namespace, "user:1", "img-7"));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true, version: "img-7", expectedVersion: "img-7" });
    });

    it("reports a 502 skew when the running image is not the expected one", async () => {
      const { namespace } = fakeNamespace(() => Response.json({ ok: true, version: "img-6" }));
      const response = await probe(agentContainerRoutes(namespace, "user:1", "img-7"));
      expect(response.status).toBe(502);
      const body = (await response.json()) as { ok: boolean; version: string; expectedVersion: string; skew: string };
      expect(body.ok).toBe(false);
      expect(body.version).toBe("img-6");
      expect(body.expectedVersion).toBe("img-7");
      expect(body.skew).toContain("image skew");
    });

    it("reports a 502 skew for a legacy image that carries no version", async () => {
      const { namespace } = fakeNamespace(() => Response.json({ ok: true }));
      const response = await probe(agentContainerRoutes(namespace, "user:1", "img-7"));
      expect(response.status).toBe(502);
      expect(await response.json()).toMatchObject({ ok: false, version: null, expectedVersion: "img-7" });
    });

    it("stays ok when no version is expected (handshake unconfigured)", async () => {
      const { namespace } = fakeNamespace(() => Response.json({ ok: true, version: "img-6" }));
      const response = await probe(agentContainerRoutes(namespace, "user:1"));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true, expectedVersion: null });
    });
  });
});
