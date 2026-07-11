import { expect, test } from "@playwright/test";

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
