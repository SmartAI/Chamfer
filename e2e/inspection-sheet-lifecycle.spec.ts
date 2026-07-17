import { expect, test } from "@playwright/test";
import { startBuild123dConversation } from "./helpers";

test("historical inspection sheets survive a multi-revision run and reload", async ({ page }, testInfo) => {
  test.setTimeout(600_000);
  await page.goto("/");
  await startBuild123dConversation(page);
  const composer = page.getByTestId("composer-input");
  await expect(composer).toBeEnabled();
  await composer.fill("sheet-lifecycle: render two CAD revisions");
  await page.getByTestId("composer-send").click();

  await expect(page.getByText("Two CAD revisions rendered and verified.")).toBeVisible({ timeout: 600_000 });
  const sheets = page.getByTestId("view-sheet-image");
  await expect(sheets).toHaveCount(2);
  await expect(page.getByTestId("tool-measurements").first()).toContainText("10 x 10 x 10");
  await expect(page.getByTestId("tool-measurements").nth(1)).toContainText("12 x 12 x 12");
  await sheets.first().screenshot({ path: testInfo.outputPath("first-revision-sheet.png") });
  await sheets.nth(1).screenshot({ path: testInfo.outputPath("second-revision-sheet.png") });
  await page.screenshot({ path: testInfo.outputPath("two-revisions.png"), fullPage: true });

  await page.reload();

  await expect(page.getByTestId("view-sheet-image")).toHaveCount(2, { timeout: 60_000 });
  await expect(page.getByText("Two CAD revisions rendered and verified.")).toBeVisible();
  await page.getByTestId("view-sheet-image").first().screenshot({
    path: testInfo.outputPath("first-revision-after-reload.png"),
  });
  await page.screenshot({ path: testInfo.outputPath("after-reload.png"), fullPage: true });
});
