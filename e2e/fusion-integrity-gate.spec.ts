import { expect, test } from "@playwright/test";

test("controlled tester sees the current integrity verdict and limitations before selecting Fusion", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("sidebar").getByRole("button", { name: "New chat", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "Choose a CAD environment" });
  await expect(dialog.getByRole("radio", { name: /Autodesk Fusion/ })).toBeVisible();
  await expect(dialog.getByText(/Integrity gate: no-go/i)).toBeVisible();
  await expect(dialog.getByText(/No Fusion release-integrity report is configured/i)).toBeVisible();
});
