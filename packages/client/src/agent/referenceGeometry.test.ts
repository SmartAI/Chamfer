import { describe, expect, it, vi } from "vitest";
import { encodeBinaryMask, extractReferenceGeometry, pixelRegionOf } from "./referenceGeometry";

describe("reference geometry helpers", () => {
  it("rounds a normalized source region outward so no source pixels are lost", () => {
    expect(pixelRegionOf({ x: 0.1, y: 0.2, width: 0.35, height: 0.4 }, 101, 99)).toEqual({
      x: 10,
      y: 19,
      width: 36,
      height: 41,
    });
  });

  it("encodes masks with a deterministic background-first run-length contract", () => {
    expect(encodeBinaryMask(new Uint8Array([0, 0, 255, 255, 0, 255]))).toEqual([2, 2, 1, 1]);
    expect(encodeBinaryMask(new Uint8Array([255, 255, 0]))).toEqual([0, 2, 1]);
    expect(encodeBinaryMask(new Uint8Array([0, 0, 0]))).toEqual([3]);
  });

  it("returns durable failed extraction evidence when the lazy dependency cannot load", async () => {
    const close = vi.fn();
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 2, height: 2, close })));
    const context = {
      drawImage: vi.fn(),
      getImageData: vi.fn(() => ({
        width: 2,
        height: 2,
        data: new Uint8ClampedArray(16),
      })),
    };
    const canvas = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as never);
    try {
      const geometry = await extractReferenceGeometry(
        { type: "image", data: "AA==", mimeType: "image/png" },
        {
          referenceId: "reference-1",
          sourceRegion: { x: 0, y: 0, width: 1, height: 1 },
          projection: "orthographic",
          direction: "front",
          visibleLandmarks: [],
          uncertainty: { level: "low", notes: "Clear outline.", occluded: false },
        },
        { load: async () => { throw new Error("OpenCV chunk unavailable"); } },
      );

      expect(geometry).toMatchObject({
        sourceSizePx: { width: 2, height: 2 },
        regionPx: { x: 0, y: 0, width: 2, height: 2 },
        extraction: {
          status: "failed",
          reason: "OpenCV chunk unavailable",
          extractor: { id: "opencv-js-contour", version: 1 },
        },
      });
      expect(close).toHaveBeenCalledOnce();
    } finally {
      canvas.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});
