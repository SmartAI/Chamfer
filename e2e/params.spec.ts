import { expect, test, type Page } from "@playwright/test";
import sharp from "sharp";

async function maxChannelDeviation(png: Buffer): Promise<number> {
  const stats = await sharp(png).removeAlpha().stats();
  return Math.max(...stats.channels.map((channel) => channel.stdev));
}

async function meanPixelDifference(before: Buffer, after: Buffer): Promise<number> {
  const stats = await sharp(before)
    .composite([{ input: after, blend: "difference" }])
    .removeAlpha()
    .stats();
  return Math.max(...stats.channels.map((channel) => channel.mean));
}

async function waitForViewerPaint(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
}

async function dragSlider(page: Page, name: string, fraction: number): Promise<void> {
  const thumb = page.getByTestId(`param-${name}`).getByRole("slider");
  const track = thumb.locator("xpath=..");
  const box = await track.boundingBox();
  if (!box) throw new Error(`Slider track for ${name} has no bounding box`);
  await thumb.hover();
  await page.mouse.down();
  await page.mouse.move(
    box.x + Math.max(1, Math.min(box.width - 1, box.width * fraction)),
    box.y + box.height / 2,
    { steps: 8 },
  );
  await page.mouse.up();
}

// Fake-LLM mode (CHAMFER_FAKE_LLM=1): the scripted agent turn produces a
// parametric 10x20x30 box whose dimensions are params. Committing a new width
// via the params panel must re-run the script locally (viewer + measurements
// update) without any new chat message.
test("param slider re-runs locally without a new chat message", async ({ page }) => {
  test.setTimeout(600_000);
  await page.goto("/");
  await page.getByTestId("sidebar").getByRole("button", { name: "New chat", exact: true }).first().click();
  const composer = page.getByTestId("composer-input");
  await expect(composer).toBeEnabled();
  await composer.fill("make a box 10 by 20 by 30");
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("tool-call-card")).toBeVisible({ timeout: 600_000 });
  // Fast-fail: a CAD failure renders "Failed" on the card; catch it here instead
  // of burning the full timeout waiting for measurements that will never come.
  await expect(page.getByTestId("tool-call-card")).not.toContainText("Failed");
  await expect(page.getByTestId("tool-measurements")).toContainText("6000", { timeout: 600_000 });
  await expect(page.getByText("All views verified")).toBeVisible({ timeout: 600_000 });

  // The successful run parses the script's params block into the panel. The
  // panel starts collapsed (calmer default), so expand it to reach the rows.
  const rightPanel = page.getByTestId("right-panel");
  await rightPanel.getByTestId("params-panel-toggle").click();
  await expect(rightPanel.getByTestId("param-width")).toBeVisible();
  await expect(rightPanel.getByTestId("param-depth")).toBeVisible();
  await expect(rightPanel.getByTestId("param-height")).toBeVisible();

  // Expose the right panel's global measurements block.
  await rightPanel.getByTestId("script-panel-toggle").click();
  const measurements = rightPanel.getByTestId("measurements");
  await expect(measurements).toContainText("10 x 20 x 30");

  const messageLocator = page.getByTestId("message-list").locator("> div");
  const messageCountBefore = await messageLocator.count();

  // Drive width to its max (100) through the numeric input and commit.
  const widthInput = rightPanel.getByTestId("param-input-width");
  await widthInput.fill("100");
  await widthInput.press("Enter");

  // The local re-run updates measurements (bbox X changes) via the
  // publishCadResult path.
  await expect(measurements).toContainText("100 x 20 x 30", { timeout: 120_000 });
  await expect(measurements).toContainText("60000");
  await expect(rightPanel.getByTestId("param-error")).toHaveCount(0);

  // No new chat message: the param edit never went through the agent.
  expect(await messageLocator.count()).toBe(messageCountBefore);

  // A new conversation owns a fresh CAD workspace. The prior model and all
  // model-scoped controls must disappear immediately.
  await page.getByTestId("sidebar").getByRole("button", { name: "New chat", exact: true }).first().click();
  await expect(rightPanel.getByTestId("viewer")).toHaveAttribute("data-has-geometry", "false");
  await expect(rightPanel.getByTestId("params-panel")).toHaveCount(0);
  await expect(rightPanel.getByTestId("export-step")).toBeDisabled();
});

test("pointer dragging accepts responsive geometry and rejects an ineffective parameter", async ({ page }, testInfo) => {
  test.setTimeout(600_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");

  const created = page.waitForResponse(
    (response) => response.url().includes("/api/conversations") && response.request().method() === "POST",
  );
  await page.getByTestId("sidebar").getByRole("button", { name: "New chat", exact: true }).first().click();
  const conversation = (await (await created).json()) as { id: string };

  const rightPanel = page.getByTestId("right-panel");
  await rightPanel.getByTestId("script-panel-toggle").click();
  const scriptInput = rightPanel.getByTestId("script-input");
  const measurements = rightPanel.getByTestId("measurements");
  const responsiveCode = `# --- params ---
width = 10  # [10, 100] Overall width in mm
# --- end params ---
from build123d import *
result = Box(width, 20, 30)`;

  await scriptInput.fill(responsiveCode);
  await rightPanel.getByTestId("script-run").click();
  await expect(measurements).toContainText("10 x 20 x 30", { timeout: 600_000 });
  await rightPanel.getByTestId("params-panel-toggle").click();

  const canvas = rightPanel.locator("canvas");
  await waitForViewerPaint(page);
  const beforePixels = await canvas.screenshot({ path: testInfo.outputPath("responsive-before.png") });
  expect(await maxChannelDeviation(beforePixels)).toBeGreaterThan(5);

  await dragSlider(page, "width", 1);
  const widthSlider = rightPanel.getByTestId("param-width").getByRole("slider");
  await expect(widthSlider).not.toHaveAttribute("aria-valuenow", "10");
  const responsiveWidth = Number(await widthSlider.getAttribute("aria-valuenow"));
  expect(responsiveWidth).toBeGreaterThan(10);
  await expect(measurements).toContainText(`${responsiveWidth} x 20 x 30`, { timeout: 120_000 });
  await expect(measurements).toContainText(String(responsiveWidth * 600));
  await expect(rightPanel.getByTestId("viewer")).toHaveAttribute("data-has-geometry", "true");
  await waitForViewerPaint(page);
  const afterPixels = await canvas.screenshot({ path: testInfo.outputPath("responsive-after.png") });
  expect(await maxChannelDeviation(afterPixels)).toBeGreaterThan(5);
  expect(await meanPixelDifference(beforePixels, afterPixels)).toBeGreaterThan(1);

  await expect.poll(async () => {
    const response = await page.request.get(`/api/conversations/${conversation.id}/artifacts`);
    return ((await response.json()) as unknown[]).length;
  }).toBe(1);
  const artifactsAfterValidDrag = await page.request.get(`/api/conversations/${conversation.id}/artifacts`);
  const validArtifacts = (await artifactsAfterValidDrag.json()) as Array<{ pySource: string }>;
  expect(validArtifacts).toHaveLength(1);
  expect(validArtifacts[0]?.pySource).toContain(`width = ${responsiveWidth}`);

  const ineffectiveCode = `# --- params ---
width = 10  # [10, 100] Overall width in mm
# --- end params ---
from build123d import *
result = Box(10, 20, 30)`;
  await scriptInput.fill(ineffectiveCode);
  await rightPanel.getByTestId("script-run").click();
  await expect(measurements).toContainText("10 x 20 x 30", { timeout: 120_000 });
  await expect(rightPanel.getByTestId("param-width").getByRole("slider")).toHaveAttribute(
    "aria-valuenow",
    "10",
  );

  await dragSlider(page, "width", 1);
  const error = rightPanel.getByTestId("param-error");
  await expect(error).toContainText("Parameter `width` does not change the executed geometry", {
    timeout: 120_000,
  });
  await expect(measurements).toContainText("10 x 20 x 30");

  const artifactsAfterRejectedDrag = await page.request.get(
    `/api/conversations/${conversation.id}/artifacts`,
  );
  expect((await artifactsAfterRejectedDrag.json()) as unknown[]).toHaveLength(1);

  await rightPanel.getByTestId("param-input-width").fill("10");
  await rightPanel.getByTestId("param-input-width").press("Enter");
  await expect(error).toHaveCount(0);
  await expect(rightPanel.getByTestId("param-width").getByRole("slider")).toHaveAttribute("aria-valuenow", "10");

  await page.reload();
  await rightPanel.getByTestId("script-panel-toggle").click();
  await expect(rightPanel.getByTestId("measurements")).toContainText(`${responsiveWidth} x 20 x 30`, {
    timeout: 600_000,
  });
  await expect(rightPanel.getByTestId("export-step")).toBeEnabled();
});
