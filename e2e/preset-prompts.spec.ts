import { expect, test } from "@playwright/test";
import { startBuild123dConversation } from "./helpers";

test("clicking a preset in an explicitly local conversation starts generation", async ({ page }) => {
  test.setTimeout(600_000);

  // Start from a profile with no conversations so the "No conversation selected"
  // homepage empty state (where the presets live) is shown.
  const existing = await page.request.get("/api/conversations");
  const conversations = (await existing.json()) as Array<{ id: string }>;
  for (const conversation of conversations) {
    await page.request.delete(`/api/conversations/${conversation.id}`);
  }

  await page.goto("/");
  await expect(page.getByText("No conversation selected")).toBeVisible();
  await expect(page.getByTestId("preset-easy")).toHaveCount(0);
  await startBuild123dConversation(page);

  const easy = page.getByTestId("preset-easy");
  await expect(easy).toBeEnabled();
  await easy.click();

  // The preset text is sent as a normal user message through session.send.
  await expect(page.getByTestId("message-list")).toContainText("cylindrical spacer");

  // Generation kicks off immediately with a visible CAD execution card.
  await expect(page.getByTestId("tool-call-card")).toBeVisible({ timeout: 600_000 });
  await expect(page.getByTitle("run_build123d")).toBeVisible();
  await expect(page.getByTestId("tool-call-card")).toContainText("Executing code");
  await expect(page.getByTestId("tool-call-card")).not.toContainText("Failed");
  // Fake LLM always builds the 10x20x30 box (volume 6000).
  await expect(page.getByTestId("tool-measurements")).toContainText("6000", { timeout: 600_000 });
  await expect(page.getByText("All views verified")).toBeVisible({ timeout: 600_000 });
});
