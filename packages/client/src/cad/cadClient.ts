import type {
  CadBootStatus,
  CadRequest,
  CadResponse,
  ExportFormat,
  Measurements,
  MeshPayload,
  ParamSpec,
} from "@chamfer/shared";
import { isCadResponse } from "@chamfer/shared";

const DEFAULT_TIMEOUT_MS = 60_000;

interface Pending {
  resolve: (res: CadResponse) => void;
  reject: (err: Error) => void;
  /** Armed only once the worker has reported boot readiness. */
  timer?: ReturnType<typeof setTimeout>;
}

function newWorker(): Worker {
  // Classic (non-module) worker: cad.worker.ts relies on importScripts to
  // load Pyodide from the CDN, which is only available in classic workers.
  return new Worker(new URL("./cad.worker.ts", import.meta.url));
}

export class CadClient {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private onBoot: (s: CadBootStatus) => void;
  // Boot readiness for the current worker. Each request awaits this before
  // arming its timeout so a cold-CDN boot (which can exceed any reasonable
  // execution cap) never eats into a request's execution budget.
  private ready!: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (err: Error) => void;
  // Set when the current worker's boot failed; the next request tears it down
  // and spawns a fresh one instead of failing forever against a rejected
  // `ready`. One respawn per request: if the fresh boot also fails, that
  // request rejects and the flag re-arms for the request after it.
  private bootFailed = false;

  constructor(onBoot: (s: CadBootStatus) => void) {
    this.onBoot = onBoot;
    this.worker = newWorker();
    this.resetReady();
    this.attach(this.worker);
  }

  private resetReady(): void {
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    // A boot failure with no requests in flight must not surface as an
    // unhandled rejection; requests observe it through their own handlers.
    this.ready.catch(() => {});
  }

  private attach(worker: Worker): void {
    worker.onmessage = (e: MessageEvent<unknown>) => {
      const data = e.data;
      if (isCadResponse(data)) {
        const pending = this.pending.get(data.id);
        if (!pending) return;
        this.pending.delete(data.id);
        clearTimeout(pending.timer);
        pending.resolve(data);
        return;
      }
      const status = data as CadBootStatus;
      if (status.phase === "ready") {
        this.resolveReady();
      } else if (status.phase === "error") {
        const error = new Error(`CAD worker failed to boot: ${status.detail}`);
        this.bootFailed = true;
        this.rejectReady(error);
        this.rejectAllPending(error);
      }
      this.onBoot(status);
    };
  }

  private send(req: CadRequest, timeoutMs: number): Promise<CadResponse> {
    if (this.bootFailed) this.respawn();
    return new Promise((resolve, reject) => {
      const entry: Pending = { resolve, reject };
      this.pending.set(req.id, entry);
      // Post immediately: the worker queues requests internally until Pyodide
      // finishes booting. Only the timeout clock waits for boot readiness.
      this.worker.postMessage(req);
      this.ready.then(
        () => {
          // Skip arming if the request already settled (or the worker was
          // replaced after a timeout, which rejects all pending requests).
          if (!this.pending.has(req.id)) return;
          entry.timer = setTimeout(() => {
            this.handleTimeout(timeoutMs);
          }, timeoutMs);
        },
        (bootError: Error) => {
          if (!this.pending.has(req.id)) return;
          this.pending.delete(req.id);
          reject(bootError);
        },
      );
    });
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private handleTimeout(timeoutMs: number): void {
    const error = new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s`);
    this.respawn();
    this.rejectAllPending(error);
  }

  /** Terminates the current worker and boots a replacement from scratch; the
   * replacement's requests must wait for a fresh 'ready' before their timers arm. */
  private respawn(): void {
    this.bootFailed = false;
    this.worker.terminate();
    this.worker = newWorker();
    this.resetReady();
    this.attach(this.worker);
  }

  async run(
    code: string,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<{ stdout: string; measurements: Measurements; mesh: MeshPayload }> {
    const id = this.nextId++;
    const res = await this.send({ id, cmd: "run", code }, timeoutMs);
    if (!res.ok) throw new Error(res.error);
    if (res.cmd !== "run") throw new Error(`Unexpected response cmd: ${res.cmd}`);
    return { stdout: res.stdout, measurements: res.measurements, mesh: res.mesh };
  }

  async parseParams(code: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<ParamSpec[]> {
    const id = this.nextId++;
    const res = await this.send({ id, cmd: "parseParams", code }, timeoutMs);
    if (!res.ok) throw new Error(res.error);
    if (res.cmd !== "parseParams") throw new Error(`Unexpected response cmd: ${res.cmd}`);
    return res.params;
  }

  async setParams(
    code: string,
    values: Record<string, number>,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<string> {
    // NaN/Infinity survive structured clone but not the JSON round-trip into
    // Python (JSON.stringify turns them into null, which set_params would
    // splice into the script as a literal `None`). Reject before any call.
    for (const value of Object.values(values)) {
      if (!Number.isFinite(value)) {
        throw new Error("non-finite param value");
      }
    }
    const id = this.nextId++;
    const res = await this.send({ id, cmd: "setParams", code, values }, timeoutMs);
    if (!res.ok) throw new Error(res.error);
    if (res.cmd !== "setParams") throw new Error(`Unexpected response cmd: ${res.cmd}`);
    return res.code;
  }

  async export(
    code: string,
    format: ExportFormat,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<{ data: Uint8Array; filename: string }> {
    const id = this.nextId++;
    const res = await this.send({ id, cmd: "export", code, format }, timeoutMs);
    if (!res.ok) throw new Error(res.error);
    if (res.cmd !== "export") throw new Error(`Unexpected response cmd: ${res.cmd}`);
    return { data: res.data, filename: res.filename };
  }

  dispose(): void {
    this.worker.terminate();
    this.rejectAllPending(new Error("CadClient disposed"));
  }
}
