import { expect, test } from "@playwright/test";
import { clearConversations } from "./helpers";

const states = ["no-document", "read-only", "busy", "unsupported", "degraded", "ready"] as const;

async function setScenario(page: import("@playwright/test").Page, state: string) {
  const response = await page.request.post(`http://127.0.0.1:8997/control/${state}`);
  expect(response.ok()).toBeTruthy();
}

test("Fusion readiness covers every fail-closed state and reconnects across all UI surfaces", async ({ page }) => {
  await setScenario(page, "ready");
  await clearConversations(page);
  await page.goto("/");
  await page.getByTestId("sidebar").getByRole("button", { name: "New chat", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "Choose a CAD environment" });
  const fusionOption = dialog.getByRole("radio", { name: /Autodesk Fusion/ });
  await expect(fusionOption).toBeVisible();

  // The client polls readiness every 8 s, so a state transition can take a
  // full poll period plus server latency to surface; give each one at least
  // two poll periods.
  for (const state of states) {
    await setScenario(page, state);
    await expect(dialog.getByRole("status")).toHaveAttribute("data-state", state, { timeout: 20_000 });
  }

  await fusionOption.check();
  await dialog.getByRole("button", { name: "Start conversation" }).click();
  const workspace = page.getByTestId("fusion-document-strip");
  await expect(workspace.getByRole("status")).toHaveAttribute("data-state", "ready");

  await setScenario(page, "wrong-document");
  await expect(workspace.getByRole("status")).toHaveAttribute("data-state", "wrong-document", { timeout: 20_000 });
  await setScenario(page, "ready");

  await page.getByRole("button", { name: "Settings" }).click();
  const settings = page.getByTestId("fusion-settings-status");
  await expect(settings.getByRole("status")).toHaveAttribute("data-state", "ready");
  await page.getByRole("button", { name: "Save" }).click();

  await setScenario(page, "unavailable");
  await expect(workspace.getByRole("status")).toHaveAttribute("data-state", "unavailable", { timeout: 20_000 });
  await setScenario(page, "incompatible");
  await expect(workspace.getByRole("status")).toHaveAttribute("data-state", "incompatible", { timeout: 20_000 });
  await setScenario(page, "ready");
  await expect(workspace.getByRole("status")).toHaveAttribute("data-state", "ready", { timeout: 20_000 });
});
