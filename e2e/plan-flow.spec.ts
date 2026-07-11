import { expect, test } from "@playwright/test";

/**
 * Full plan-artifact loop against the scripted fake LLM (CHAMFER_FAKE_LLM=1):
 * the agent plans two components, builds the base, records it done
 * (evidence-checked against the gate), stops prematurely, gets the
 * deterministic plan nudge, builds the assembly, and completes the plan.
 */
test("plan artifact loop: plan card, evidence-checked progress, stop-gate nudge", async ({ page }) => {
  test.setTimeout(600_000);
  await page.goto("/");
  await page.getByTestId("sidebar").getByRole("button", { name: "New chat", exact: true }).first().click();
  const composer = page.getByTestId("composer-input");
  await expect(composer).toBeEnabled();
  await composer.fill("plan-flow: build a base plate with a lid resting on it");
  await page.getByTestId("composer-send").click();

  // The accepted plan renders as the live card with both components pending.
  const planCard = page.getByTestId("plan-card");
  await expect(planCard).toBeVisible({ timeout: 600_000 });
  await expect(page.getByTestId("plan-progress")).toHaveText("0/2 components");

  // Base run passes its gate and update_plan records it done (evidence-checked).
  await expect(page.getByTestId("plan-progress")).toHaveText("1/2 components", { timeout: 600_000 });

  // The premature stop draws the deterministic plan nudge as a system chip.
  await expect(page.getByTestId("plan-nudge-chip")).toBeVisible({ timeout: 600_000 });

  // The nudge forces the assembly run; the plan completes and the turn ends.
  await expect(page.getByTestId("plan-progress")).toHaveText("2/2 components", { timeout: 600_000 });
  await expect(page.getByText("Assembly complete", { exact: false }).first()).toBeVisible({ timeout: 600_000 });

  // The conversation badge reflects the assembly's passing gate.
  await expect(page.getByTestId("verify-chip")).toHaveAttribute("data-status", "passed");

  // Expanded card: both components ticked done.
  await page.getByTestId("plan-card-toggle").click();
  const components = page.getByTestId("plan-component");
  await expect(components).toHaveCount(2);
  await expect(components.nth(0)).toHaveAttribute("data-status", "done");
  await expect(components.nth(1)).toHaveAttribute("data-status", "done");

  // Replay: the plan card and statuses survive a reload (derived from the transcript).
  await page.reload();
  await expect(page.getByTestId("plan-card")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("plan-progress")).toHaveText("2/2 components");
});
