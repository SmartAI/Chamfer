import { describe, expect, it } from "vitest";
import {
  fetchOnlineHealth,
  runCronProbe,
  type CronProbeDeps,
  type HealthProbeResult,
  type ProbeAlert,
} from "./cronProbe";

/** Collects alerts a probe run raises, with a stubbed health source and (by
 * default) no budget source. Overrides let each test drive one input. */
async function probe(overrides: Partial<CronProbeDeps>): Promise<ProbeAlert[]> {
  const alerts: ProbeAlert[] = [];
  const deps: CronProbeDeps = {
    fetchHealth: async () => ({ status: 200, body: { ok: true, missing: [], degraded: [] } }),
    alert: (alert) => alerts.push(alert),
    ...overrides,
  };
  await runCronProbe(deps);
  return alerts;
}

const healthy: HealthProbeResult = {
  status: 200,
  body: { ok: true, service: "chamfer-online", missing: [], degraded: [] },
};

describe("runCronProbe health alerting", () => {
  it("is a no-op against a fully healthy deployment", async () => {
    const alerts = await probe({ fetchHealth: async () => healthy });
    expect(alerts).toEqual([]);
  });

  it("alerts when the deployment reports a degraded capability", async () => {
    const alerts = await probe({
      fetchHealth: async () => ({
        status: 200,
        body: { ok: true, service: "chamfer-online", missing: [], degraded: ["agent-hosting"] },
      }),
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.message).toContain("agent-hosting");
  });

  it("raises an error when a client-critical route is missing (503)", async () => {
    const alerts = await probe({
      fetchHealth: async () => ({
        status: 503,
        body: { ok: false, service: "chamfer-online", missing: ["/api/conversations"], degraded: [] },
      }),
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.severity).toBe("error");
    expect(alerts[0]?.message).toContain("/api/conversations");
  });

  it("raises an error when the health endpoint is unreachable", async () => {
    const alerts = await probe({ fetchHealth: async () => ({ status: 0, body: null }) });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.severity).toBe("error");
  });

  it("treats a malformed-but-parseable body (no boolean ok) as unreachable", async () => {
    const alerts = await probe({
      fetchHealth: async () => ({ status: 200, body: {} as never }),
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.severity).toBe("error");
  });
});

describe("runCronProbe demo-budget alerting", () => {
  it("stays quiet below the first threshold", async () => {
    const alerts = await probe({
      fetchHealth: async () => healthy,
      readDemoBudget: async () => ({ spentMicroUsd: 500, capMicroUsd: 1000 }),
    });
    expect(alerts).toEqual([]);
  });

  it("warns once the month crosses the first threshold", async () => {
    const alerts = await probe({
      fetchHealth: async () => healthy,
      readDemoBudget: async () => ({ spentMicroUsd: 850, capMicroUsd: 1000 }),
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.severity).toBe("warning");
  });

  it("errors once the monthly cap is reached", async () => {
    const alerts = await probe({
      fetchHealth: async () => healthy,
      readDemoBudget: async () => ({ spentMicroUsd: 1000, capMicroUsd: 1000 }),
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.severity).toBe("error");
  });

  it("skips the budget check when the deployment funds no demo", async () => {
    const alerts = await probe({
      fetchHealth: async () => healthy,
      readDemoBudget: async () => ({ spentMicroUsd: 0, capMicroUsd: 0 }),
    });
    expect(alerts).toEqual([]);
  });
});

/** The user-DO namespace stand-in from agentContainer.test.ts, narrowed to what
 * fetchOnlineHealth uses: idFromName + a stub whose fetch runs a handler. */
function fakeNamespace(
  handler: () => Promise<Response> | Response,
): { namespace: DurableObjectNamespace; names: string[] } {
  const names: string[] = [];
  const namespace = {
    idFromName: (name: string) => {
      names.push(name);
      return name as unknown as DurableObjectId;
    },
    get: () => ({ fetch: async () => handler() }),
  } as unknown as DurableObjectNamespace;
  return { namespace, names };
}

describe("fetchOnlineHealth", () => {
  it("routes to the system-health DO and returns its parsed report", async () => {
    const { namespace, names } = fakeNamespace(() =>
      Response.json({ ok: true, missing: [], degraded: [] }),
    );
    const result = await fetchOnlineHealth(namespace);
    expect(names).toEqual(["__system_health__"]);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, degraded: [] });
  });

  it("surfaces a degraded 503 report verbatim for the probe to alert on", async () => {
    const { namespace } = fakeNamespace(() =>
      Response.json({ ok: false, missing: ["/api/settings"], degraded: [] }, { status: 503 }),
    );
    const result = await fetchOnlineHealth(namespace);
    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({ ok: false, missing: ["/api/settings"] });
  });

  it("degrades to an unreachable reading when the DO fetch throws", async () => {
    const { namespace } = fakeNamespace(() => {
      throw new Error("DO is gone");
    });
    const result = await fetchOnlineHealth(namespace);
    expect(result).toEqual({ status: 0, body: null });
  });
});

// The composition the scheduled handler runs (worker.ts): fetchOnlineHealth
// against the real system-health DO, piped into runCronProbe. Proven here
// end to end against a synthetic DO so a degraded deployment provably alerts
// and a healthy one provably does not.
describe("scheduled probe against a synthetic system-health DO", () => {
  async function run(handler: () => Response): Promise<ProbeAlert[]> {
    const { namespace } = fakeNamespace(handler);
    const alerts: ProbeAlert[] = [];
    await runCronProbe({
      fetchHealth: () => fetchOnlineHealth(namespace),
      alert: (alert) => alerts.push(alert),
    });
    return alerts;
  }

  it("alerts on a degraded /api/online/health response", async () => {
    const alerts = await run(() =>
      Response.json(
        { ok: false, service: "chamfer-online", missing: ["/api/conversations"], degraded: ["agent-hosting"] },
        { status: 503 },
      ),
    );
    expect(alerts.some((a) => a.severity === "error")).toBe(true);
    expect(alerts.map((a) => a.message).join(" ")).toContain("/api/conversations");
  });

  it("is a no-op on a healthy /api/online/health response", async () => {
    const alerts = await run(() =>
      Response.json({ ok: true, service: "chamfer-online", missing: [], degraded: [] }),
    );
    expect(alerts).toEqual([]);
  });
});
