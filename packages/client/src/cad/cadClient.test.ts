import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CadBootStatus, CadRequest, CadResponse } from "@chamfer/shared";
import { CadClient } from "./cadClient";

class FakeWorker {
  onmessage: ((e: MessageEvent<unknown>) => void) | null = null;
  posted: CadRequest[] = [];
  terminated = false;

  postMessage(msg: CadRequest): void {
    this.posted.push(msg);
  }

  terminate(): void {
    this.terminated = true;
  }

  // Test helper: simulate a message arriving from the worker.
  emit(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent<unknown>);
  }
}

describe("CadClient", () => {
  let workers: FakeWorker[];

  beforeEach(() => {
    workers = [];
    vi.stubGlobal(
      "Worker",
      class {
        constructor() {
          const w = new FakeWorker();
          workers.push(w);
          return w as unknown as Worker;
        }
      },
    );
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function latestWorker(): FakeWorker {
    const w = workers[workers.length - 1];
    if (!w) throw new Error("no worker constructed yet");
    return w;
  }

  it("forwards boot status messages", () => {
    const onBoot = vi.fn();
    new CadClient(onBoot);
    const w = latestWorker();

    const status: CadBootStatus = { phase: "downloading", detail: "Pyodide runtime" };
    w.emit(status);

    expect(onBoot).toHaveBeenCalledWith(status);
  });

  it("correlates concurrent run() calls to their own results by request id", async () => {
    const client = new CadClient(vi.fn());
    const w = latestWorker();

    const p1 = client.run("code-a");
    const p2 = client.run("code-b");

    expect(w.posted).toHaveLength(2);
    const runs = w.posted as Array<Extract<CadRequest, { cmd: "run" }>>;
    const req1 = runs[0];
    const req2 = runs[1];
    if (!req1 || !req2) throw new Error("expected two posted requests");
    expect(req1.code).toBe("code-a");
    expect(req2.code).toBe("code-b");
    expect(req1.id).not.toBe(req2.id);

    // Resolve out of order to prove correlation is by id, not call order.
    const res2: CadResponse = {
      id: req2.id,
      ok: true,
      cmd: "run",
      stdout: "b-out",
      measurements: { bboxMm: [1, 2, 3], volumeMm3: 6, areaMm2: 22, children: [] },
      mesh: { positions: new Float32Array([1]), indices: new Uint32Array([0]) },
    };
    const res1: CadResponse = {
      id: req1.id,
      ok: true,
      cmd: "run",
      stdout: "a-out",
      measurements: { bboxMm: [4, 5, 6], volumeMm3: 120, areaMm2: 148, children: [] },
      mesh: { positions: new Float32Array([2]), indices: new Uint32Array([0]) },
    };
    w.emit(res2);
    w.emit(res1);

    await expect(p1).resolves.toMatchObject({ stdout: "a-out" });
    await expect(p2).resolves.toMatchObject({ stdout: "b-out" });
  });

  it("passes the verify gate through run() untouched", async () => {
    const client = new CadClient(vi.fn());
    const w = latestWorker();

    const p = client.run("code");
    const gate = {
      status: "failed" as const,
      checks: [{ name: "bodies", passed: false, detail: "bodies: expected 1, found 2" }],
    };
    const req = w.posted[0] as Extract<CadRequest, { cmd: "run" }>;
    w.emit({
      id: req.id,
      ok: true,
      cmd: "run",
      stdout: "",
      measurements: { bboxMm: [1, 1, 1], volumeMm3: 1, areaMm2: 6, children: [] },
      mesh: { positions: new Float32Array([1]), indices: new Uint32Array([0]) },
      gate,
    } satisfies CadResponse);

    await expect(p).resolves.toMatchObject({ gate });
  });

  it("correlates parseParams() and setParams() to their own responses by request id", async () => {
    const client = new CadClient(vi.fn());
    const w = latestWorker();

    const pParse = client.parseParams("code-with-params");
    const pSet = client.setParams("code-with-params", { overall_width: 120 });

    expect(w.posted).toHaveLength(2);
    const parseReq = w.posted[0] as Extract<CadRequest, { cmd: "parseParams" }>;
    const setReq = w.posted[1] as Extract<CadRequest, { cmd: "setParams" }>;
    expect(parseReq.cmd).toBe("parseParams");
    expect(parseReq.code).toBe("code-with-params");
    expect(setReq.cmd).toBe("setParams");
    expect(setReq.values).toEqual({ overall_width: 120 });
    expect(parseReq.id).not.toBe(setReq.id);

    // Respond out of order to prove correlation is by id, not call order.
    w.emit({
      id: setReq.id,
      ok: true,
      cmd: "setParams",
      code: "rewritten-code",
    } satisfies CadResponse);
    w.emit({
      id: parseReq.id,
      ok: true,
      cmd: "parseParams",
      params: [{ name: "overall_width", value: 80, min: 40, max: 200, description: "Overall width in mm" }],
    } satisfies CadResponse);

    await expect(pParse).resolves.toEqual([
      { name: "overall_width", value: 80, min: 40, max: 200, description: "Overall width in mm" },
    ]);
    await expect(pSet).resolves.toBe("rewritten-code");
  });

  it("rejects parseParams() and setParams() with the error string on ok:false", async () => {
    const client = new CadClient(vi.fn());
    const w = latestWorker();

    const pParse = client.parseParams("bad-code");
    const pSet = client.setParams("bad-code", { nope: 1 });
    const parseReq = w.posted[0] as Extract<CadRequest, { cmd: "parseParams" }>;
    const setReq = w.posted[1] as Extract<CadRequest, { cmd: "setParams" }>;

    w.emit({ id: parseReq.id, ok: false, cmd: "parseParams", error: "SyntaxError: boom" } satisfies CadResponse);
    w.emit({ id: setReq.id, ok: false, cmd: "setParams", error: "KeyError: 'nope'" } satisfies CadResponse);

    await expect(pParse).rejects.toThrow("SyntaxError: boom");
    await expect(pSet).rejects.toThrow("KeyError: 'nope'");
  });

  it("rejects setParams() with non-finite values before posting to the worker", async () => {
    const client = new CadClient(vi.fn());
    const w = latestWorker();

    await expect(client.setParams("code", { w: Number.NaN })).rejects.toThrow(
      "non-finite param value",
    );
    await expect(client.setParams("code", { w: Number.POSITIVE_INFINITY })).rejects.toThrow(
      "non-finite param value",
    );
    await expect(client.setParams("code", { w: Number.NEGATIVE_INFINITY })).rejects.toThrow(
      "non-finite param value",
    );

    // Nothing reached the worker, so nothing could round-trip NaN through JSON.
    expect(w.posted).toHaveLength(0);
  });

  it("correlates concurrent export() calls to their own results by request id", async () => {
    const client = new CadClient(vi.fn());
    const w = latestWorker();

    const pStep = client.export("code-a", "step");
    const pPy = client.export("code-a", "py");

    expect(w.posted).toHaveLength(2);
    const stepReq = w.posted[0] as Extract<CadRequest, { cmd: "export" }>;
    const pyReq = w.posted[1] as Extract<CadRequest, { cmd: "export" }>;
    expect(stepReq.cmd).toBe("export");
    expect(stepReq.format).toBe("step");
    expect(pyReq.format).toBe("py");
    expect(stepReq.id).not.toBe(pyReq.id);

    // Respond out of order to prove correlation is by id, not call order.
    w.emit({
      id: pyReq.id,
      ok: true,
      cmd: "export",
      data: new Uint8Array([112, 121]),
      filename: "model.py",
    } satisfies CadResponse);
    w.emit({
      id: stepReq.id,
      ok: true,
      cmd: "export",
      data: new Uint8Array([73, 83, 79]),
      filename: "model.step",
    } satisfies CadResponse);

    await expect(pStep).resolves.toEqual({
      data: new Uint8Array([73, 83, 79]),
      filename: "model.step",
    });
    await expect(pPy).resolves.toEqual({
      data: new Uint8Array([112, 121]),
      filename: "model.py",
    });
  });

  it("rejects export() with the error string on ok:false", async () => {
    const client = new CadClient(vi.fn());
    const w = latestWorker();

    const promise = client.export("bad-code", "step");
    const req = w.posted[0] as Extract<CadRequest, { cmd: "export" }>;
    w.emit({ id: req.id, ok: false, cmd: "export", error: "Unknown export format: 'obj'" } satisfies CadResponse);

    await expect(promise).rejects.toThrow("Unknown export format: 'obj'");
  });

  it("rejects run() with the error string when the worker posts ok:false", async () => {
    const client = new CadClient(vi.fn());
    const w = latestWorker();

    const promise = client.run("bad-code");
    const req = w.posted[0] as Extract<CadRequest, { cmd: "run" }>;
    w.emit({ id: req.id, ok: false, cmd: "run", error: "Traceback: boom" } satisfies CadResponse);

    await expect(promise).rejects.toThrow("Traceback: boom");
  });

  it("on timeout: rejects pending calls, terminates the worker, and constructs a new one", async () => {
    const client = new CadClient(vi.fn());
    const w1 = latestWorker();

    w1.emit({ phase: "ready" } satisfies CadBootStatus);
    const promise = client.run("slow-code", 1000);
    const expectation = expect(promise).rejects.toThrow("Timed out after 1s");

    await vi.advanceTimersByTimeAsync(1000);
    await expectation;

    expect(w1.terminated).toBe(true);
    expect(workers).toHaveLength(2);
    expect(workers[1]).not.toBe(w1);

    // The client should be usable again via the freshly constructed worker.
    const w2 = latestWorker();
    const nextPromise = client.run("fresh-code");
    const nextReq = w2.posted[0] as Extract<CadRequest, { cmd: "run" }>;
    w2.emit({
      id: nextReq.id,
      ok: true,
      cmd: "run",
      stdout: "ok",
      measurements: { bboxMm: [0, 0, 0], volumeMm3: 0, areaMm2: 0, children: [] },
      mesh: { positions: new Float32Array(), indices: new Uint32Array() },
    } satisfies CadResponse);

    await expect(nextPromise).resolves.toMatchObject({ stdout: "ok" });
  });

  it("does not arm the execution timeout while the worker is still booting", async () => {
    const client = new CadClient(vi.fn());
    const w = latestWorker();

    // Default 60s cap; a cold-CDN boot can take far longer than that.
    const promise = client.run("cold-boot-code");
    let settled = false;
    promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await vi.advanceTimersByTimeAsync(120_000);
    expect(settled).toBe(false);
    expect(w.terminated).toBe(false);

    w.emit({ phase: "ready" } satisfies CadBootStatus);
    const req = w.posted[0] as Extract<CadRequest, { cmd: "run" }>;
    w.emit({
      id: req.id,
      ok: true,
      cmd: "run",
      stdout: "done",
      measurements: { bboxMm: [1, 1, 1], volumeMm3: 1, areaMm2: 6, children: [] },
      mesh: { positions: new Float32Array(), indices: new Uint32Array() },
    } satisfies CadResponse);

    await expect(promise).resolves.toMatchObject({ stdout: "done" });
  });

  it("still times out when execution itself exceeds the cap after boot is ready", async () => {
    const client = new CadClient(vi.fn());
    const w = latestWorker();

    const promise = client.run("slow-after-ready", 1000);
    const expectation = expect(promise).rejects.toThrow("Timed out after 1s");

    // Boot-wait: nothing may time out here.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(w.terminated).toBe(false);

    w.emit({ phase: "ready" } satisfies CadBootStatus);
    await vi.advanceTimersByTimeAsync(999);
    expect(w.terminated).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expectation;
    expect(w.terminated).toBe(true);
  });

  it("rejects pending requests when boot fails", async () => {
    const client = new CadClient(vi.fn());
    const w = latestWorker();

    const promise = client.run("never-runs");
    const expectation = expect(promise).rejects.toThrow("CAD worker failed to boot: CDN unreachable");

    w.emit({ phase: "error", detail: "CDN unreachable" } satisfies CadBootStatus);

    await expectation;
  });

  it("respawns the worker on the next request after a boot failure", async () => {
    const client = new CadClient(vi.fn());
    const w1 = latestWorker();

    const p1 = client.run("first");
    const expectation = expect(p1).rejects.toThrow("CAD worker failed to boot: CDN down");
    w1.emit({ phase: "error", detail: "CDN down" } satisfies CadBootStatus);
    await expectation;

    // The failed worker is only replaced lazily, by the next request.
    expect(workers).toHaveLength(1);

    const p2 = client.run("second");
    expect(workers).toHaveLength(2);
    expect(w1.terminated).toBe(true);
    const w2 = latestWorker();
    expect(w2.posted).toHaveLength(1);

    w2.emit({ phase: "ready" } satisfies CadBootStatus);
    const req = w2.posted[0] as Extract<CadRequest, { cmd: "run" }>;
    w2.emit({
      id: req.id,
      ok: true,
      cmd: "run",
      stdout: "recovered",
      measurements: { bboxMm: [0, 0, 0], volumeMm3: 0, areaMm2: 0, children: [] },
      mesh: { positions: new Float32Array(), indices: new Uint32Array() },
    } satisfies CadResponse);

    await expect(p2).resolves.toMatchObject({ stdout: "recovered" });
  });

  it("rejects again (one respawn per request) when the replacement worker also fails to boot", async () => {
    const client = new CadClient(vi.fn());
    const w1 = latestWorker();

    const p1 = client.run("first");
    const firstRejection = expect(p1).rejects.toThrow("CAD worker failed to boot: CDN down");
    w1.emit({ phase: "error", detail: "CDN down" } satisfies CadBootStatus);
    await firstRejection;

    const p2 = client.run("second");
    expect(workers).toHaveLength(2);
    const w2 = latestWorker();
    const secondRejection = expect(p2).rejects.toThrow("CAD worker failed to boot: still down");
    w2.emit({ phase: "error", detail: "still down" } satisfies CadBootStatus);
    await secondRejection;

    // A later request gets another fresh worker; failures never wedge the client.
    void client.run("third").catch(() => {});
    expect(workers).toHaveLength(3);
  });
});
