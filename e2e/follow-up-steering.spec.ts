import { expect, test } from "@playwright/test";

test("a follow-up steers the active agent run before it completes", async ({ page }) => {
  await page.goto("/");
  const [newChatResponse] = await Promise.all([
    page.waitForResponse((response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname === "/api/conversations",
    ),
    page.getByTestId("sidebar").getByRole("button", { name: "New chat", exact: true }).first().click(),
  ]);
  expect(newChatResponse.ok()).toBe(true);
  const { id: conversationId } = await newChatResponse.json() as { id: string };

  const composer = page.getByTestId("composer-input");
  await expect(composer).toBeEnabled({ timeout: 60_000 });
  await composer.fill("follow-up-steering-hold: start a box design");
  await page.getByTestId("composer-send").click();

  await expect.poll(async () => {
    const status = await (
      await page.request.get(`/api/test/fake-model-holds?conversationId=${conversationId}`)
    ).json() as { held: boolean };
    return status.held;
  }).toBe(true);

  await composer.fill("change the width to 40 mm");
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("queued-message")).toContainText("change the width to 40 mm");
  await expect.poll(async () => {
    const result = await (
      await page.request.post(`/api/test/fake-model-holds/release?conversationId=${conversationId}`)
    ).json() as { released: boolean };
    return result.released;
  }).toBe(true);

  await expect(page.getByText("Correction consumed by the active run before it completed.")).toBeVisible();
  await expect(page.getByTestId("queued-message")).toHaveCount(0);

  const diagnostics = await (
    await page.request.get(`/api/test/fake-model-requests?conversationId=${conversationId}`)
  ).json() as { requests: Array<{ sequence: number; messageCount: number }> };
  expect(diagnostics.requests).toEqual([
    expect.objectContaining({ sequence: 1, messageCount: 1 }),
    expect.objectContaining({ sequence: 2, messageCount: 3 }),
  ]);

  const rows = await (
    await page.request.get(`/api/conversations/${conversationId}/messages`)
  ).json() as Array<{ seq: number; role: string; contentJson: string }>;
  const corrections = rows.filter((row) => row.contentJson.includes("change the width to 40 mm"));
  expect(corrections).toHaveLength(1);
  expect(corrections[0]).toMatchObject({ seq: 2, role: "user" });
});
