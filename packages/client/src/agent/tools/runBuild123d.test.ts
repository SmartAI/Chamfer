import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Measurements, MeshPayload } from "@chamfer/shared";
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
