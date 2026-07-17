import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { persistRenderedCanvasEvidence } from "./browserCase";

describe("rendered canvas evidence", () => {
  it("persists the exact hashed PNG bytes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chamfer-canvas-evidence-"));
    const screenshot = await sharp(Buffer.from([
      0, 0, 0,
      255, 255, 255,
    ]), { raw: { width: 2, height: 1, channels: 3 } }).png().toBuffer();

    const evidence = await persistRenderedCanvasEvidence({
      screenshot,
      rawEvidenceDir: directory,
      filename: "canvas.png",
    });

    const persisted = await readFile(join(directory, "canvas.png"));
    expect(persisted).toEqual(screenshot);
    expect(evidence.reference).toBe(
      `raw/screenshots/canvas.png#sha256:${createHash("sha256").update(persisted).digest("hex")}`,
    );
  });

  it("rejects a uniform canvas", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chamfer-canvas-evidence-"));
    const screenshot = await sharp({
      create: { width: 2, height: 2, channels: 3, background: "white" },
    }).png().toBuffer();

    await expect(persistRenderedCanvasEvidence({
      screenshot,
      rawEvidenceDir: directory,
      filename: "blank.png",
    })).rejects.toThrow("blank or uniform");
  });
});
