import { expect, type Page, type Response } from "@playwright/test";

/** Uses the production chooser to explicitly create a Local build123d conversation. */
export async function startBuild123dConversation(page: Page): Promise<Response> {
  const created = page.waitForResponse(
    (response) => response.request().method() === "POST" && response.url().endsWith("/api/conversations"),
  );
  await page.getByTestId("sidebar").getByRole("button", { name: "New chat", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "Choose a CAD environment" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("radio", { name: /Local build123d/ }).check();
  await dialog.getByRole("button", { name: "Start conversation" }).click();
  return created;
}

export async function clearConversations(page: Page): Promise<void> {
  const conversations = await (await page.request.get("/api/conversations")).json() as Array<{ id: string }>;
  for (const conversation of conversations) await page.request.delete(`/api/conversations/${conversation.id}`);
}
