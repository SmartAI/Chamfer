import { expect, test } from "@playwright/test";

test("renders a 1400 by 700 inspection sheet for a CAD result", async ({ page }) => {
  test.setTimeout(600_000);
  await page.goto("/");
  await page.getByTestId("script-panel-toggle").click();
  await page.getByTestId("script-input").fill("from build123d import *\nresult = Box(10, 20, 30)");
  await page.getByTestId("script-run").click();
  await expect(page.getByTestId("measurements")).toContainText("6000", { timeout: 600_000 });

  await page.getByTestId("script-viewsheet").click();
  const sheet = page.getByTestId("view-sheet-image");
  await expect(sheet).toBeVisible();
  await expect
    .poll(() => sheet.evaluate((image: HTMLImageElement) => [image.naturalWidth, image.naturalHeight]))
    .toEqual([1400, 700]);
  const sampledColors = await sheet.evaluate((image: HTMLImageElement) => {
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) return 0;
    context.drawImage(image, 0, 0);
    const colors = new Set<string>();
    for (let y = 25; y < canvas.height; y += 50) {
      for (let x = 25; x < canvas.width; x += 50) {
        colors.add(Array.from(context.getImageData(x, y, 1, 1).data).join(","));
      }
    }
    return colors.size;
  });
  expect(sampledColors).toBeGreaterThan(4);
});
