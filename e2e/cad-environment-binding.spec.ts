import { expect, test } from "@playwright/test";

test("a new conversation is explicitly and permanently bound to one CAD environment", async ({ page }) => {
  const existing = await page.request.get("/api/conversations");
  const conversations = (await existing.json()) as Array<{ id: string }>;
  for (const conversation of conversations) {
    await page.request.delete(`/api/conversations/${conversation.id}`);
  }

  await page.goto("/");
  await page.getByTestId("sidebar").getByRole("button", { name: "New chat", exact: true }).first().click();

  const dialog = page.getByRole("dialog", { name: "Choose a CAD environment" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("radio", { name: /Local build123d/ })).toBeChecked();
  await expect(dialog.getByRole("radio", { name: /Autodesk Fusion/ })).not.toBeChecked();
  await expect(page.getByTestId("composer-input")).toHaveCount(0);
  await expect(await (await page.request.get("/api/conversations")).json()).toEqual([]);

  await dialog.getByRole("radio", { name: /Autodesk Fusion/ }).check();
  const createdResponse = page.waitForResponse(
    (response) => response.request().method() === "POST" && response.url().endsWith("/api/conversations"),
  );
  await dialog.getByRole("button", { name: "Start conversation" }).click();
  const created = (await (await createdResponse).json()) as { id: string; cadEnvironment: string };
  expect(created.cadEnvironment).toBe("fusion");

  await expect(page.getByTestId("cad-environment-badge")).toHaveText("Autodesk Fusion");
  // Fusion conversations are chat-only: the document strip replaces the whole
  // right panel because the native Fusion canvas is the authoritative view.
  await expect(page.getByTestId("fusion-document-strip")).toBeVisible();
  await expect(page.getByTestId("right-panel")).toHaveCount(0);
  await expect(page.getByTestId("preset-easy")).toHaveCount(0);
  await expect(page.getByTestId("composer-input")).toBeEnabled();

  await page.reload();
  await expect(page.getByTestId("cad-environment-badge")).toHaveText("Autodesk Fusion");
  await expect(page.getByTestId("fusion-document-strip")).toBeVisible();
  await expect(page.getByTestId("right-panel")).toHaveCount(0);

  await page.getByTestId("sidebar").getByRole("button", { name: "New chat", exact: true }).first().click();
  await expect(dialog.getByRole("radio", { name: /Autodesk Fusion/ })).toBeChecked();
  await dialog.getByRole("radio", { name: /Local build123d/ }).check();
  await dialog.getByRole("button", { name: "Cancel" }).click();

  await expect(page.getByTestId("cad-environment-badge")).toHaveText("Autodesk Fusion");
  const persisted = (await (
    await page.request.get(`/api/conversations/${created.id}`)
  ).json()) as { cadEnvironment: string };
  expect(persisted.cadEnvironment).toBe("fusion");
  expect((await (await page.request.get("/api/conversations")).json()) as unknown[]).toHaveLength(1);
});
