import { statSync } from "node:fs";
import { test, expect } from "@playwright/test";

// Deviation from the original plan: this spec does not use fake-LLM mode
// (not built yet). It drives the dev script panel directly, the same flow
// as cad-playground.spec.ts, then exercises the export path.
test("exports the current script as a STEP file", async ({ page }) => {
  test.setTimeout(600_000); // first boot downloads wheels

  await page.goto("/");
  await page.getByTestId("script-panel-toggle").click();
  await page.getByTestId("script-input").fill("from build123d import *\nresult = Box(10, 20, 30)");

  // Export buttons stay disabled until a script has run successfully.
  await expect(page.getByTestId("export-step")).toBeDisabled();

  await page.getByTestId("script-run").click();
  await expect(page.getByTestId("measurements")).toContainText("6000", { timeout: 600_000 });

  await expect(page.getByTestId("export-step")).toBeEnabled();
  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("export-step").click();
  const download = await downloadPromise;

  expect(download.suggestedFilename()).toBe("model.step");
  const path = await download.path();
  expect(statSync(path).size).toBeGreaterThan(1024);
});
