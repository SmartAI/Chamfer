/** Minimal stand-in for workerd's cloudflare:workers module, aliased in
 * vitest.config.ts so plain-Node vitest can load modules whose import graph
 * reaches @cloudflare/containers. Covers only what that graph touches at
 * module load; tests never instantiate these classes. */
export class DurableObject {
  constructor(
    public ctx: unknown,
    public env: unknown,
  ) {}
}

export class WorkerEntrypoint {
  constructor(
    public ctx: unknown,
    public env: unknown,
  ) {}
}
