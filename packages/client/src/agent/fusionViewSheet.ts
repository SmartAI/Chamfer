import type { FusionScreenshotDto } from "@chamfer/shared";

/** A composed multi-view sheet ready to hand to the model as pixels. */
export interface FusionViewSheet {
  image: { type: "image"; data: string; mimeType: "image/png" };
  views: string[];
}

/**
 * Compose the captured Fusion views into one labelled montage image - the exact
 * "view sheet fed to the LLM" workflow the build123d path uses, made backend-agnostic.
 * A single sheet keeps the layout legible (each view at full resolution, side by side)
 * and costs far fewer image tokens than N separate blocks. Returns undefined when there
 * is nothing to show or no canvas is available (jsdom without a 2D context), so callers
 * degrade to text-only rather than throwing.
 */
export async function composeFusionViewSheet(
  screenshots: readonly FusionScreenshotDto[],
): Promise<FusionViewSheet | undefined> {
  if (screenshots.length === 0 || typeof document === "undefined") return undefined;
  const images = await Promise.all(
    screenshots.map(async (screenshot) => createImageBitmap(await (await fetch(screenshot.dataUrl)).blob())),
  );
  try {
    const cellWidth = Math.max(...images.map((image) => image.width));
    const cellHeight = Math.max(...images.map((image) => image.height));
    const columns = Math.min(3, images.length);
    const canvas = document.createElement("canvas");
    canvas.width = cellWidth * columns;
    canvas.height = cellHeight * Math.ceil(images.length / columns);
    const context = canvas.getContext("2d");
    if (!context) return undefined;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    images.forEach((image, index) => {
      const x = (index % columns) * cellWidth;
      const y = Math.floor(index / columns) * cellHeight;
      context.drawImage(image, x, y, cellWidth, cellHeight);
      context.fillStyle = "rgba(0, 0, 0, 0.75)";
      context.fillRect(x, y, Math.min(cellWidth, 180), 28);
      context.fillStyle = "#ffffff";
      context.font = "16px sans-serif";
      context.fillText(screenshots[index]!.view, x + 8, y + 20);
    });
    return {
      image: { type: "image", data: canvas.toDataURL("image/png").split(",")[1]!, mimeType: "image/png" },
      views: screenshots.map((screenshot) => screenshot.view),
    };
  } finally {
    images.forEach((image) => image.close());
  }
}
