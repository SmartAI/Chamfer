import { test, expect } from "@playwright/test";

test("boots pyodide and runs a box script", async ({ page }) => {
  test.setTimeout(600_000); // first boot downloads wheels
  await page.goto("/");
  await page.getByTestId("script-panel-toggle").click();
  await page.getByTestId("script-input").fill("from build123d import *\nresult = Box(10, 20, 30)");
  await page.getByTestId("script-run").click();
  await expect(page.getByTestId("measurements")).toContainText("10", { timeout: 600_000 });
  await expect(page.getByTestId("measurements")).toContainText("6000");
  await expect(page.locator("canvas")).toBeVisible();
});
