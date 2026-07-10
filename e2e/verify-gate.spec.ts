import { expect, test } from "@playwright/test";

// The fake LLM's "gate-fail" scenario declares an EXPECT bbox the produced box
// never has; the verify gate must fail and the failure must be visible on the
// tool card. See packages/server/src/fakeLlm.ts.
test("a failing verify gate is reported on the tool card", async ({ page }) => {
  test.setTimeout(600_000);
  await page.goto("/");
  await page.getByTestId("sidebar").getByRole("button", { name: "New chat", exact: true }).first().click();
  const composer = page.getByTestId("composer-input");
  await expect(composer).toBeEnabled();
  await composer.fill("make a gate-fail box");
  await page.getByTestId("composer-send").click();

  await expect(page.getByTestId("tool-call-card")).toBeVisible({ timeout: 600_000 });
  // The run itself succeeds (the geometry builds); only the gate fails.
  await expect(page.getByTestId("tool-call-card")).not.toContainText("Failed");
  const gate = page.getByTestId("tool-gate");
  await expect(gate).toBeVisible({ timeout: 600_000 });
  await expect(gate).toContainText("failed");
  await expect(gate).toContainText("bbox_mm");
});
