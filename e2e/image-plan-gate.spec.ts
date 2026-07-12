import { expect, test } from "@playwright/test";

test("image design rejects CAD and incomplete plans before rendering a mapped spec sheet", async ({ page }) => {
  test.setTimeout(600_000);
  await page.goto("/");
  await page.getByTestId("sidebar").getByRole("button", { name: "New chat", exact: true }).first().click();
  const composer = page.getByTestId("composer-input");
  await expect(composer).toBeEnabled();
  await composer.fill("image-plan-gate: build the dimensioned spacer in this drawing");
  await page.getByTestId("composer-file-input").setInputFiles({
    name: "spacer.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ),
  });
  await page.getByTestId("composer-send").click();

  const rejectedRun = page
    .getByRole("button", { name: "run_build123d Failed", exact: true })
    .locator("..");
  await expect(rejectedRun).toContainText("update_plan", { timeout: 600_000 });
  await expect(rejectedRun).toContainText("spec sheet");

  const rejectedPlan = page
    .getByRole("button", { name: "update_plan Failed", exact: true })
    .locator("..");
  await expect(rejectedPlan).toContainText("spec_sheet is required", { timeout: 600_000 });

  const planCard = page.getByTestId("plan-card");
  await expect(planCard).toBeVisible({ timeout: 600_000 });
  await expect(page.getByTestId("plan-progress")).toHaveText("1/1 components", { timeout: 600_000 });
  await page.getByTestId("plan-card-toggle").click();
  await expect(page.getByTestId("plan-spec-row")).toHaveCount(2);
  await expect(page.getByTestId("plan-spec-check-link")).toContainText("spacer envelope");
  await expect(page.getByTestId("plan-spec-unverifiable")).toContainText("cannot measure surface finish");

  const completedRun = page
    .getByRole("button", { name: "run_build123d Complete", exact: true })
    .locator("..");
  await expect(completedRun.getByTestId("tool-gate")).toHaveAttribute("data-status", "passed", { timeout: 600_000 });
});
