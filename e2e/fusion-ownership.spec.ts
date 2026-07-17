import { expect, test, type Page } from "@playwright/test";
import { clearConversations } from "./helpers";

async function setScenario(page: Page, scenario: string) {
  const response = await page.request.post(`http://127.0.0.1:8997/control/${scenario}`);
  expect(response.ok()).toBeTruthy();
}

async function createFusionConversation(page: Page): Promise<string> {
  await page.getByTestId("sidebar").getByRole("button", { name: "New chat", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "Choose a CAD environment" });
  await dialog.getByRole("radio", { name: /Autodesk Fusion/ }).check();
  const createdResponse = page.waitForResponse(
    (response) => response.request().method() === "POST" && response.url().endsWith("/api/conversations"),
  );
  await dialog.getByRole("button", { name: "Start conversation" }).click();
  return ((await (await createdResponse).json()) as { id: string }).id;
}

test("Fusion document binding survives reload, blocks wrong tabs, and transfers ownership explicitly", async ({ page }) => {
  await setScenario(page, "ready");
  await page.goto("/");
  await clearConversations(page);
  await page.reload();

  const firstId = await createFusionConversation(page);
  const workspace = page.getByTestId("fusion-document-strip");
  await expect(workspace.getByTestId("fusion-ownership-role")).toHaveText("Owner");
  await expect(workspace.getByTestId("fusion-bound-document")).toContainText("Readiness Fixture");

  await page.reload();
  await expect(workspace.getByTestId("fusion-ownership-role")).toHaveText("Owner");

  await setScenario(page, "wrong-document");
  await expect(workspace.getByRole("status")).toHaveAttribute("data-state", "wrong-document", { timeout: 10_000 });
  await setScenario(page, "ready");
  await expect(workspace.getByRole("status")).toHaveAttribute("data-state", "ready", { timeout: 10_000 });

  const secondId = await createFusionConversation(page);
  expect(secondId).not.toBe(firstId);
  await expect(workspace.getByTestId("fusion-ownership-role")).toHaveText("Read only");
  await workspace.getByRole("button", { name: "Transfer ownership to this conversation" }).click();
  await expect(workspace.getByTestId("fusion-ownership-role")).toHaveText("Owner");

  await page.locator(`[data-conversation-id="${firstId}"]`).click();
  await expect(workspace.getByTestId("fusion-ownership-role")).toHaveText("Read only");
});

test("closing an unsaved bound document makes the conversation non-resumable", async ({ page }) => {
  await setScenario(page, "provisional");
  await page.goto("/");
  await clearConversations(page);
  await page.reload();

  await createFusionConversation(page);
  const workspace = page.getByTestId("fusion-document-strip");
  await expect(workspace.getByTestId("fusion-identity-kind")).toHaveText("Unsaved document");

  await setScenario(page, "provisional-lost");
  await expect(workspace.getByTestId("fusion-resumability")).toHaveText("Cannot resume", { timeout: 10_000 });
  await page.reload();
  await expect(workspace.getByTestId("fusion-resumability")).toHaveText("Cannot resume");
});
