// Surviving e2e surface after the pi-coding-agent pivot: the app boots, a
// conversation can be created through the CAD-environment chooser, history
// renders, and deletion works. Agent turns themselves need a real model and a
// real MCP server, which this hermetic stack does not provide.
import { expect, test } from "@playwright/test";
import { clearConversations, startBuild123dConversation } from "./helpers";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await clearConversations(page);
  await page.reload();
});

test("boots, creates a build123d conversation, and deletes it", async ({ page }) => {
  await expect(page.getByTestId("sidebar")).toBeVisible();

  const created = await startBuild123dConversation(page);
  expect(created.ok()).toBe(true);

  // The new conversation opens with the empty-state chat surface and viewer.
  await expect(page.getByTestId("chat-header")).toBeVisible();
  await expect(page.getByTestId("message-list")).toBeVisible();
  await expect(page.getByTestId("cad-environment-badge")).toHaveText("Local build123d");
  await expect(page.getByTestId("viewer")).toBeVisible();

  // Conversation CRUD: it is listed, and deleting empties the sidebar list.
  const conversations = await (await page.request.get("/api/conversations")).json() as Array<{ id: string }>;
  expect(conversations).toHaveLength(1);
  await page.request.delete(`/api/conversations/${conversations[0]!.id}`);
  await page.reload();
  await expect(page.getByText("No conversation selected")).toBeVisible();
});
