import { expect, test } from "@playwright/test";
import { FUS_TEXT_001 } from "@chamfer/fusion-fixtures";
import { clearConversations } from "./helpers";

const fakeFusion = `http://127.0.0.1:${process.env.FUSION_FAKE_PORT ?? "8997"}`;

async function prepareVerifiedUnsaved(page: import("@playwright/test").Page) {
  await page.request.post(`${fakeFusion}/trace/reset`);
  await page.request.post(`${fakeFusion}/control/provisional`);
  await clearConversations(page);
  await page.goto("/");
  await page.getByTestId("sidebar").getByRole("button", { name: "New chat", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "Choose a CAD environment" });
  await dialog.getByRole("radio", { name: /Autodesk Fusion/ }).check();
  await dialog.getByRole("button", { name: "Start conversation" }).click();
  await expect(page.getByRole("button", { name: "Save verified Fusion document" })).toHaveCount(0);
  await page.getByTestId("composer-input").fill(FUS_TEXT_001.prompt);
  await page.getByTestId("composer-send").click();
  // The deterministic plan stop-gate can nudge the scripted fake into restating
  // its final text; assert presence, not uniqueness.
  await expect(page.getByText(/FUS-TEXT-001 is complete on one inspected Fusion revision/).first()).toBeVisible({ timeout: 90_000 });
  await expect(page.getByRole("status", { name: "Verified unsaved Fusion work" })).toContainText("Verified, not saved");
}

test("explicit Save promotes verified unsaved Fusion identity and survives reload", async ({ page }) => {
  await prepareVerifiedUnsaved(page);
  await page.getByRole("button", { name: "Save verified Fusion document" }).click();
  await expect(page.getByTestId("fusion-identity-kind")).toHaveText("Saved Fusion document");
  await expect(page.getByTestId("fusion-saved-version")).toContainText("Fusion version 1");
  await page.reload();
  await expect(page.getByTestId("fusion-identity-kind")).toHaveText("Saved Fusion document");
  await expect(page.getByTestId("fusion-saved-version")).toContainText("fake-version-1");
});

test("canceled explicit Save remains honestly verified and unsaved", async ({ page }) => {
  await prepareVerifiedUnsaved(page);
  await page.request.post(`${fakeFusion}/save-outcome/canceled`);
  await page.getByRole("button", { name: "Save verified Fusion document" }).click();
  await expect(page.getByRole("alert")).toContainText("Fusion Save was canceled");
  await expect(page.getByRole("status", { name: "Verified unsaved Fusion work" })).toContainText("Verified, not saved");
  await expect(page.getByTestId("fusion-identity-kind")).toHaveText("Unsaved document");
});

test("failed explicit Save remains honestly verified and unsaved", async ({ page }) => {
  await prepareVerifiedUnsaved(page);
  await page.request.post(`${fakeFusion}/save-outcome/failed`);
  await page.getByRole("button", { name: "Save verified Fusion document" }).click();
  await expect(page.getByRole("alert")).toContainText("Fusion Save failed");
  await expect(page.getByRole("status", { name: "Verified unsaved Fusion work" })).toContainText("Verified, not saved");
  await expect(page.getByTestId("fusion-identity-kind")).toHaveText("Unsaved document");
});
