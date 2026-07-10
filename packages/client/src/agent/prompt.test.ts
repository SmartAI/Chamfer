import { describe, expect, it } from "vitest";
import { systemPrompt } from "./prompt";

describe("systemPrompt", () => {
  it("documents the allowed build123d API surface", () => {
    expect(systemPrompt).toContain("## Allowed API Surface");
    expect(systemPrompt).toContain("Builders: BuildPart, BuildSketch, BuildLine");
    expect(systemPrompt).toContain("Operations: extrude, revolve, loft, sweep, fillet, chamfer");
    expect(systemPrompt).toContain("Shape composition: Part algebra with +, -, and &");
  });

  it("contains a concrete DO NOT list for runtime-unsafe behavior", () => {
    expect(systemPrompt).toContain("## DO NOT");
    expect(systemPrompt).toContain("Do not use file I/O, network I/O, subprocesses");
    expect(systemPrompt).toContain("Do not call show, show_object");
    expect(systemPrompt).toContain("Do not rely on state, variables, files, or geometry from a previous run_build123d call");
  });

  it("requires multi-view and numeric verification before success", () => {
    expect(systemPrompt).toContain("## Verification Discipline");
    expect(systemPrompt).toContain("Inspect every view one at a time: isometric, front, back, left, right, top, and bottom");
    expect(systemPrompt).toContain("Numerically check each requested width, height, depth, diameter");
    expect(systemPrompt).toContain("read the full traceback and fix the first real cause");
  });

  it("keeps the canonical params example with the decimal hole diameter", () => {
    expect(systemPrompt).toContain("hole_diameter = 6.5  # [2, 12] Mounting hole diameter in mm");
  });

  it("stays below the prompt size budget", () => {
    expect(systemPrompt.length).toBeLessThan(16_000);
  });
});
