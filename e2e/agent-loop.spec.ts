import { expect, test } from "@playwright/test";
import { startBuild123dConversation } from "./helpers";

test("full agent loop with fake LLM", async ({ page }) => {
  test.setTimeout(600_000);
  await page.goto("/");
  await startBuild123dConversation(page);
  const composer = page.getByTestId("composer-input");
  await expect(composer).toBeEnabled();
  await composer.fill("make a box 10 by 20 by 30");
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("tool-call-card")).toBeVisible({ timeout: 600_000 });
  await expect(page.getByTitle("run_build123d")).toBeVisible();
  await expect(page.getByTestId("tool-call-card")).toContainText("Executing code");
  // Fast-fail: a CAD failure renders "Failed" on the card; catch it here instead
  // of burning the full timeout waiting for measurements that will never come.
  await expect(page.getByTestId("tool-call-card")).not.toContainText("Failed");
  await expect(page.getByTestId("tool-measurements")).toContainText("6000", { timeout: 600_000 });
  await expect(page.getByTestId("tool-gate")).toHaveAttribute("data-status", "passed");
  await expect(page.getByTestId("tool-gate")).toContainText("GATE PASSED");
  await expect(page.getByText("All views verified")).toBeVisible({ timeout: 600_000 });
  // Ambient trust indicators: header chip and sidebar dot reflect the verdict.
  await expect(page.getByTestId("verify-chip")).toHaveAttribute("data-status", "passed");
  await expect(page.getByTestId("verify-chip")).toContainText("Verified");
  await expect(page.getByTestId("convo-gate-dot").first()).toHaveAttribute("data-status", "passed");
  await expect(page.getByTestId("result-feedback")).toBeVisible();
  await page.getByRole("button", { name: "Helpful result", exact: true }).click();
  await expect(page.getByTestId("result-feedback-confirmation")).toContainText("Thanks for the feedback.");
  await page.reload();
  // Replay path re-fetches conversations, messages, and artifacts; give it the
  // same headroom as the rest of the spec instead of the 5s default, which
  // flakes when the spec runs late in a serial battery on a loaded machine.
  await expect(page.getByTestId("tool-call-card")).toBeVisible({ timeout: 60_000 });
});
