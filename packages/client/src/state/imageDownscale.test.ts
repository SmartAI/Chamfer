import { afterEach, describe, expect, it, vi } from "vitest";
import { readPromptImage, scaledDimensions } from "./chatState";

// The scaling contract behind the prompt-image downscale: cap the long edge at
// MAX_IMAGE_EDGE (1568) while preserving aspect ratio, so a phone photo stays
// under the server's 1 MB conversation-event cap and its turn persists.
describe("scaledDimensions", () => {
  it("leaves an image already within the edge limit untouched", () => {
    expect(scaledDimensions(800, 600, 1568)).toEqual({ width: 800, height: 600 });
    expect(scaledDimensions(1568, 1000, 1568)).toEqual({ width: 1568, height: 1000 });
  });

  it("caps the long edge and preserves aspect ratio (landscape)", () => {
    expect(scaledDimensions(4032, 3024, 1568)).toEqual({ width: 1568, height: 1176 });
  });

  it("caps the long edge and preserves aspect ratio (portrait)", () => {
    expect(scaledDimensions(3024, 4032, 1568)).toEqual({ width: 1176, height: 1568 });
  });

  it("never rounds a dimension down to zero for an extreme aspect ratio", () => {
    const { width, height } = scaledDimensions(10000, 3, 1568);
    expect(width).toBe(1568);
    expect(height).toBe(1);
  });
});

// Regression guard for the "The requested file could not be read" NotReadableError:
// a real Chrome <input> File reads lazily from disk on every access, so the send
// path must read the OS-backed File exactly once. The downscale decode must run
// against the bytes already in hand (an in-memory Blob), never the File again.
describe("readPromptImage reads the File once", () => {
  const realCreateImageBitmap = globalThis.createImageBitmap;

  afterEach(() => {
    globalThis.createImageBitmap = realCreateImageBitmap;
    vi.restoreAllMocks();
  });

  it("decodes for downscale from an in-memory Blob, not the OS File", async () => {
    const readSpy = vi.spyOn(FileReader.prototype, "readAsDataURL");
    const bitmapSources: unknown[] = [];
    globalThis.createImageBitmap = (async (source: ImageBitmapSource) => {
      bitmapSources.push(source);
      return { width: 4000, height: 3000, close: () => {} } as unknown as ImageBitmap;
    }) as typeof globalThis.createImageBitmap;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      { drawImage: () => {} } as unknown as CanvasRenderingContext2D,
    );
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/jpeg;base64,QUJD");

    const file = new File([new Uint8Array([1, 2, 3, 4])], "photo.jpg", { type: "image/jpeg" });
    const payload = await readPromptImage(file);

    // The oversized bitmap forces the downscale branch, yielding JPEG.
    expect(payload.mimeType).toBe("image/jpeg");
    // The OS-backed File is read exactly once...
    const fileReads = readSpy.mock.calls.filter(([arg]) => arg === file);
    expect(fileReads).toHaveLength(1);
    // ...and the decode never touches the File, only an in-memory Blob copy.
    expect(bitmapSources).toHaveLength(1);
    expect(bitmapSources[0]).not.toBe(file);
    expect(bitmapSources[0]).toBeInstanceOf(Blob);
  });

  it("keeps the original bytes when downscale is unavailable (jsdom/no canvas)", async () => {
    // jsdom exposes no createImageBitmap, so the passthrough must still work off
    // a single File read and preserve the source format.
    globalThis.createImageBitmap = undefined as unknown as typeof globalThis.createImageBitmap;
    const readSpy = vi.spyOn(FileReader.prototype, "readAsDataURL");
    const file = new File([new Uint8Array([137, 80, 78, 71])], "logo.png", { type: "image/png" });

    const payload = await readPromptImage(file);

    expect(payload.mimeType).toBe("image/png");
    expect(readSpy.mock.calls.filter(([arg]) => arg === file)).toHaveLength(1);
  });
});
