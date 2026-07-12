import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { BUILD123D_VERSION } from "./versions";

const workerSource = readFileSync(resolve(process.cwd(), "src/cad/cad.worker.ts"), "utf8");
const modulePreamble = workerSource.slice(0, workerSource.indexOf("const PYODIDE_VERSION"));

describe("CAD classic worker source", () => {
  it("contains no runtime imports", () => {
    expect(modulePreamble).not.toMatch(/^import(?!\s+type\b)/m);
  });

  it("uses the shared build123d version", () => {
    const match = workerSource.match(/const BUILD123D_VERSION = "([^"]+)";/);
    expect(match?.[1]).toBe(BUILD123D_VERSION);
  });
});
