import { expect, test } from "@playwright/test";
import { startBuild123dConversation } from "./helpers";

test("text requirements are durable, separately visible, and survive reload", async ({ page }, testInfo) => {
  test.setTimeout(600_000);
  await page.goto("/");
  await startBuild123dConversation(page);

  const composer = page.getByTestId("composer-input");
  await expect(composer).toBeEnabled();
  await composer.fill("plan-flow: build a 30 x 30 x 6 mm base plate with a 30 x 30 x 4 mm lid resting on it");
  await page.getByTestId("composer-send").click();

  const specifications = page.getByTestId("source-specifications-card");
  await expect(specifications).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("source-specifications-toggle").click();
  await expect(page.getByTestId("source-specification")).toHaveCount(3);
  await expect(specifications).toContainText("30 x 30 x 6 mm base plate");
  await expect(specifications).toContainText("30 x 30 x 4 mm lid");
  await expect(specifications).toContainText("lid resting on it");
  await expect(page.getByTestId("plan-card")).toBeVisible({ timeout: 600_000 });
  await expect(page.getByTestId("plan-progress")).toHaveText("2/2 components", { timeout: 600_000 });
  await expect(page.getByText("Assembly complete", { exact: false }).first()).toBeVisible({ timeout: 600_000 });

  const conversationsResponse = await page.request.get("/api/conversations");
  expect(conversationsResponse.ok()).toBe(true);
  const conversations = await conversationsResponse.json() as Array<{ id: string }>;
  const conversationId = conversations[0]!.id;
  const specificationResponse = await page.request.get(`/api/conversations/${conversationId}/source-specifications`);
  expect(specificationResponse.ok()).toBe(true);
  const persistedSpecifications = await specificationResponse.json() as Array<{
    id: string;
    requirement: string;
    source: { messageId: string; text: string; start: number; end: number };
    actor: "agent";
    status: "active";
    timestamp: number;
  }>;
  expect(persistedSpecifications.map((specification) => specification.id)).toEqual([
    "base-envelope",
    "lid-envelope",
    "lid-resting",
  ]);
  expect(persistedSpecifications.every((specification) => specification.actor === "agent" && specification.status === "active")).toBe(true);

  await expect.poll(async () => {
    const response = await page.request.get(`/api/conversations/${conversationId}/messages`);
    const messages = await response.json() as Array<{ contentJson: string }>;
    return messages.some((message) => {
      const content = JSON.parse(message.contentJson) as { toolName?: string; isError?: boolean };
      return content.toolName === "create_plan" && !content.isError;
    });
  }, { timeout: 60_000 }).toBe(true);
  const messagesResponse = await page.request.get(`/api/conversations/${conversationId}/messages`);
  const persistedMessages = await messagesResponse.json() as Array<{ seq: number; contentJson: string }>;
  const parsedMessages = persistedMessages.map((message) => ({
    seq: message.seq,
    content: JSON.parse(message.contentJson) as { role?: string; toolName?: string; isError?: boolean },
  }));
  const sourceResultSeq = parsedMessages.find((message) =>
    message.content.role === "toolResult" && message.content.toolName === "record_source_specifications" && !message.content.isError)!.seq;
  const firstPlanSeq = parsedMessages.find((message) =>
    message.content.role === "toolResult" && message.content.toolName === "create_plan" && !message.content.isError)!.seq;
  expect(sourceResultSeq).toBeLessThan(firstPlanSeq);

  const exactRetry = await page.request.post(`/api/conversations/${conversationId}/source-specifications`, {
    headers: { "Idempotency-Key": "plan-flow-source-specifications" },
    data: {
      specifications: persistedSpecifications.map(({ id, requirement, source }) => ({ id, requirement, source })),
    },
  });
  expect(exactRetry.ok()).toBe(true);
  expect(await exactRetry.json()).toEqual(persistedSpecifications);

  await page.reload();
  await expect(page.getByTestId("source-specifications-card")).toBeVisible({ timeout: 60_000 });
  await page.getByTestId("source-specifications-toggle").click();
  await expect(page.getByTestId("source-specification")).toHaveCount(3);
  await expect(page.getByTestId("plan-card")).toBeVisible();
  await expect(page.getByTestId("plan-progress")).toHaveText("2/2 components");
  await page.getByTestId("message-list").evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.screenshot({ path: testInfo.outputPath("source-specifications-reload.png"), fullPage: true });
});
