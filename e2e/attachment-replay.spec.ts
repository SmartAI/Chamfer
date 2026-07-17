import { expect, test } from "@playwright/test";
import { startBuild123dConversation } from "./helpers";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

test("uploaded image persists as a reference and renders unchanged after reload", async ({ page }, testInfo) => {
  await page.goto("/");
  await startBuild123dConversation(page);
  const composer = page.getByTestId("composer-input");
  await expect(composer).toBeEnabled();
  await composer.fill("attachment-replay: remember this reference image");
  await page.getByTestId("composer-file-input").setInputFiles({
    name: "reference.png",
    mimeType: "image/png",
    buffer: PNG_1X1,
  });
  await page.getByTestId("composer-send").click();

  await expect(page.getByText("Received 1 native image block.")).toBeVisible();
  const image = page.getByTestId("message-user-image");
  await expect(image).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("before-reload.png"), fullPage: true });

  const conversations = (await (await page.request.get("/api/conversations")).json()) as Array<{ id: string }>;
  const messages = (await (
    await page.request.get(`/api/conversations/${conversations[0]!.id}/messages`)
  ).json()) as Array<{ role: string; contentJson: string }>;
  const persistedUser = messages.find((message) => message.role === "user");
  expect(persistedUser?.contentJson).toContain('"type":"attachment-reference"');
  expect(persistedUser?.contentJson).not.toContain('"type":"image"');
  expect(persistedUser?.contentJson).not.toContain("base64");

  await page.reload();
  await expect(page.getByText("Received 1 native image block.")).toBeVisible();
  await expect(page.getByTestId("message-user-image")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("after-reload.png"), fullPage: true });

  await page.route("**/api/attachments/*", async (route) => {
    await route.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify({ error: "corrupt" }) });
  });
  await page.reload();
  await expect(page.getByText("Attachment corrupt")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("broken-attachment.png"), fullPage: true });
});
