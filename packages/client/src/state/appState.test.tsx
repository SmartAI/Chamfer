import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CadRequest, CadResponse, Measurements, MeshPayload } from "@chamfer/shared";
import { AppStateProvider, type AppState, useAppState } from "./appState";

class FakeWorker {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  posted: CadRequest[] = [];

  postMessage(message: CadRequest): void {
    this.posted.push(message);
  }

  terminate(): void {}

  emit(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent<unknown>);
  }
}

const OLD_MEASUREMENTS: Measurements = {
  bboxMm: [10, 20, 30],
  volumeMm3: 6000,
  areaMm2: 2200,
  children: [],
};
const NEW_MEASUREMENTS: Measurements = {
  bboxMm: [20, 20, 30],
  volumeMm3: 12000,
  areaMm2: 3200,
  children: [],
};
const OLD_MESH: MeshPayload = {
  positions: new Float32Array([1, 2, 3]),
  indices: new Uint32Array([0]),
};
const NEW_MESH: MeshPayload = {
  positions: new Float32Array([4, 5, 6]),
  indices: new Uint32Array([0]),
};

function latestRequest<T extends CadRequest["cmd"]>(worker: FakeWorker, cmd: T): Extract<CadRequest, { cmd: T }> {
  for (let index = worker.posted.length - 1; index >= 0; index -= 1) {
    const candidate = worker.posted[index];
    if (candidate?.cmd === cmd) return candidate as Extract<CadRequest, { cmd: T }>;
  }
  throw new Error(`No ${cmd} request was posted`);
}

describe("AppState parameter transaction", () => {
  let workers: FakeWorker[];
  let state: AppState;

  function StateProbe() {
    state = useAppState();
    return null;
  }

  beforeEach(() => {
    workers = [];
    vi.stubGlobal(
      "Worker",
      class {
        constructor() {
          const worker = new FakeWorker();
          workers.push(worker);
          return worker as unknown as Worker;
        }
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function renderReadyState(): Promise<FakeWorker> {
    render(
      <AppStateProvider>
        <StateProbe />
      </AppStateProvider>,
    );
    await waitFor(() => expect(workers).toHaveLength(1));
    const worker = workers[0]!;
    await act(async () => worker.emit({ phase: "ready" }));
    await act(async () => {
      state.publishCadResult({ mesh: OLD_MESH, measurements: OLD_MEASUREMENTS });
      state.restoreScript("width = 10");
    });
    await waitFor(() => expect(worker.posted.some((request) => request.cmd === "parseParams")).toBe(true));
    const parseRequest = latestRequest(worker, "parseParams");
    await act(async () => {
      worker.emit({ id: parseRequest.id, ok: true, cmd: "parseParams", params: [] } satisfies CadResponse);
    });
    return worker;
  }

  async function finishCandidateRun(worker: FakeWorker): Promise<void> {
    await waitFor(() => expect(worker.posted.some((request) => request.cmd === "setParams")).toBe(true));
    const setRequest = latestRequest(worker, "setParams");
    await act(async () => {
      worker.emit({ id: setRequest.id, ok: true, cmd: "setParams", code: "width = 20" } satisfies CadResponse);
    });
    await waitFor(() => expect(worker.posted.some((request) => request.cmd === "run")).toBe(true));
    const runRequest = latestRequest(worker, "run");
    await act(async () => {
      worker.emit({
        id: runRequest.id,
        ok: true,
        cmd: "run",
        stdout: "",
        measurements: NEW_MEASUREMENTS,
        mesh: NEW_MESH,
        gate: {
          status: "passed",
          checks: [{ name: "parameter_width", passed: true, detail: "responsive" }],
        },
      } satisfies CadResponse);
    });
  }

  it("keeps the last valid local and durable artifact when persistence rejects", async () => {
    const worker = await renderReadyState();
    const durableArtifacts = ["width = 10"];
    const persist = vi.fn(async (_code: string) => {
      throw new Error("artifact store unavailable");
    });

    const edit = state.applyParams({ width: 20 }, persist);
    const rejection = edit.then(
      () => undefined,
      (error: unknown) => error,
    );
    await finishCandidateRun(worker);

    await expect(rejection).resolves.toEqual(new Error("artifact store unavailable"));
    expect(persist).toHaveBeenCalledWith("width = 20");
    expect(durableArtifacts).toEqual(["width = 10"]);
    expect(state.currentScript).toBe("width = 10");
    expect(state.measurements).toEqual(OLD_MEASUREMENTS);
    expect(state.mesh).toEqual(OLD_MESH);
  });

  it("publishes a verified edit without a persistence hook", async () => {
    const worker = await renderReadyState();

    const edit = state.applyParams({ width: 20 });
    await finishCandidateRun(worker);

    await expect(edit).resolves.toBe("width = 20");
    expect(state.currentScript).toBe("width = 20");
    expect(state.measurements).toEqual(NEW_MEASUREMENTS);
    expect(state.mesh).toEqual(NEW_MESH);
  });

  it("reports a superseded restore run so stale artifact identity cannot overwrite newer CAD", async () => {
    const worker = await renderReadyState();
    const restore = state.runScript("restore-code");
    const manual = state.runScript("manual-code");
    await waitFor(() => expect(worker.posted.filter((request) => request.cmd === "run")).toHaveLength(2));
    const runs = worker.posted.filter((request): request is Extract<CadRequest, { cmd: "run" }> => request.cmd === "run");
    const restoreRequest = runs.find((request) => request.code === "restore-code")!;
    const manualRequest = runs.find((request) => request.code === "manual-code")!;
    await act(async () => {
      worker.emit({
        id: manualRequest.id,
        ok: true,
        cmd: "run",
        stdout: "",
        measurements: NEW_MEASUREMENTS,
        mesh: NEW_MESH,
        gate: { status: "passed", checks: [] },
      } satisfies CadResponse);
      worker.emit({
        id: restoreRequest.id,
        ok: true,
        cmd: "run",
        stdout: "",
        measurements: OLD_MEASUREMENTS,
        mesh: OLD_MESH,
        gate: { status: "passed", checks: [] },
      } satisfies CadResponse);
    });

    await expect(manual).resolves.toBe(true);
    await expect(restore).resolves.toBe(false);
    expect(state.currentScript).toBe("manual-code");
    expect(state.measurements).toEqual(NEW_MEASUREMENTS);
  });
});
