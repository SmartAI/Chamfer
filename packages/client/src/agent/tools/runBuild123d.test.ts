import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Gate, Measurements, MeshPayload } from "@chamfer/shared";
import type { CadClient } from "@/cad/cadClient";
import { renderViewSheet } from "@/viewer/viewSheet";
import { createRunBuild123dTool } from "./runBuild123d";

vi.mock("@/viewer/viewSheet", () => ({ renderViewSheet: vi.fn() }));

const measurements: Measurements = {
  bboxMm: [10, 20, 30],
  volumeMm3: 6000,
  areaMm2: 2200,
  children: [],
};
const mesh: MeshPayload = {
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  indices: new Uint32Array([0, 1, 2]),
};

describe("run_build123d tool", () => {
  beforeEach(() => vi.mocked(renderViewSheet).mockReset());

  it("returns measurements and a PNG while publishing the successful run", async () => {
    const cad = {
      run: vi.fn().mockResolvedValue({ stdout: "built", measurements, mesh }),
    } as unknown as CadClient;
    const sheetPng = new Blob(["png-data"], { type: "image/png" });
    vi.mocked(renderViewSheet).mockResolvedValue(sheetPng);
    const onSuccess = vi.fn().mockResolvedValue(undefined);
    const tool = createRunBuild123dTool({ cad, onSuccess });

    const result = await tool.execute("call-1", { code: "result = Box(10, 20, 30)" });

    expect(cad.run).toHaveBeenCalledWith("result = Box(10, 20, 30)");
    expect(onSuccess).toHaveBeenCalledWith({
      code: "result = Box(10, 20, 30)",
      mesh,
      measurements,
      sheetPng,
    });
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Measurements:") });
    expect(result.content[1]).toEqual({
      type: "image",
      data: expect.any(String),
      mimeType: "image/png",
    });
    expect(result.details).toEqual({ measurements });
  });

  async function textForGate(gate: Gate | undefined): Promise<string> {
    const cad = {
      run: vi.fn().mockResolvedValue({ stdout: "", measurements, mesh, gate }),
    } as unknown as CadClient;
    vi.mocked(renderViewSheet).mockResolvedValue(new Blob(["png"], { type: "image/png" }));
    const tool = createRunBuild123dTool({ cad, onSuccess: vi.fn().mockResolvedValue(undefined) });
    const result = await tool.execute("call-g", { code: "code" });
    const first = result.content[0];
    if (first?.type !== "text") throw new Error("expected text content");
    return first.text;
  }

  it("reports a passing gate in one line", async () => {
    const text = await textForGate({
      status: "passed",
      checks: [{ name: "valid", passed: true, detail: "B-rep validity (is_valid)" }],
    });
    expect(text).toContain("Verify gate: PASSED");
    expect(text).not.toContain("FAILED");
  });

  it("lists each failing check and demands a fix on gate failure", async () => {
    const text = await textForGate({
      status: "failed",
      checks: [
        { name: "valid", passed: true, detail: "B-rep validity (is_valid)" },
        { name: "bodies", passed: false, detail: "bodies: expected 1, found 2" },
        { name: "bbox", passed: false, detail: "bbox_mm (sorted): expected [10, 20, 30] ±0.5, measured [9, 20, 30]" },
      ],
    });
    expect(text).toContain("Verify gate: FAILED");
    expect(text).toContain("bodies: expected 1, found 2");
    expect(text).toContain("bbox_mm (sorted)");
    expect(text).not.toContain("B-rep validity"); // passing checks stay quiet
    expect(text).toMatch(/fix every failing check/i);
  });

  it("reports an errored gate as unavailable without failing the run", async () => {
    const text = await textForGate({
      status: "error",
      checks: [{ name: "gate", passed: false, detail: "gate evaluator failed: boom" }],
    });
    expect(text).toContain("Verify gate: unavailable");
    expect(text).toContain("boom");
  });

  it("omits the gate section when the worker sent none", async () => {
    const text = await textForGate(undefined);
    expect(text).not.toContain("Verify gate");
  });

  it("rethrows a CAD traceback without publishing a result", async () => {
    const cad = {
      run: vi.fn().mockRejectedValue(new Error("Traceback: invalid fillet")),
    } as unknown as CadClient;
    const onSuccess = vi.fn();
    const tool = createRunBuild123dTool({ cad, onSuccess });

    await expect(tool.execute("call-2", { code: "bad code" })).rejects.toThrow("Traceback: invalid fillet");
    expect(onSuccess).not.toHaveBeenCalled();
    expect(renderViewSheet).not.toHaveBeenCalled();
  });
});
