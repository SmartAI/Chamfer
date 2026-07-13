import { expect, test, type Locator } from "@playwright/test";
import { readFileSync } from "node:fs";

const PRIMARY_PNG = readFileSync("packages/client/public/brand/chamfer-mark-512.png");
const CORRECTED_PNG = readFileSync("packages/client/public/brand/chamfer-logo.png");

async function expectVisibleReferenceImages(images: Locator) {
  await expect(images).toHaveCount(2);
  await images.first().scrollIntoViewIfNeeded();
  for (let index = 0; index < 2; index += 1) {
    const image = images.nth(index);
    await expect(image).toBeVisible();
    const box = await image.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(48);
    expect(box?.height).toBeGreaterThanOrEqual(30);
  }
}

test("rejects premature CAD then records complementary and superseding reference history", async ({ page }, testInfo) => {
  await page.goto("/");
  await page.getByTestId("sidebar").getByRole("button", { name: "New chat", exact: true }).first().click();
  const composer = page.getByTestId("composer-input");
  await expect(composer).toBeEnabled();
  await composer.fill("reference-classification-gate: use these primary and corrected drawings");
  await page.getByTestId("composer-file-input").setInputFiles([
    { name: "primary.png", mimeType: "image/png", buffer: PRIMARY_PNG },
    { name: "corrected-front.png", mimeType: "image/png", buffer: CORRECTED_PNG },
  ]);
  await page.getByTestId("composer-send").click();

  const rejectedRun = page
    .getByRole("button", { name: "run_build123d Failed", exact: true })
    .locator("..");
  await expect(rejectedRun).toContainText("classify_reference", { timeout: 120_000 });
  await expect(rejectedRun).toContainText("unclassified");
  await expect(page.getByRole("button", { name: "classify_reference Complete", exact: true })).toHaveCount(3, {
    timeout: 120_000,
  });
  await expect(page.getByText(/Reference classifications recorded/).last()).toBeVisible({ timeout: 120_000 });
  const classifiedImages = page.getByTestId("message-user-image");
  await expectVisibleReferenceImages(classifiedImages);
  await page.screenshot({ path: testInfo.outputPath("classified-images-visible.png"), fullPage: true });

  const conversations = (await (await page.request.get("/api/conversations")).json()) as Array<{ id: string }>;
  const records = (await (
    await page.request.get(`/api/conversations/${conversations[0]!.id}/references`)
  ).json()) as Array<{
    status: string;
    relationships: Array<{ type: string; referenceId: string }>;
    history: Array<{ status: string; actor: string; timestamp: number }>;
  }>;
  expect(records).toHaveLength(2);
  expect(records[0]).toMatchObject({
    status: "superseded",
    history: [{ status: "active", actor: "agent" }, { status: "superseded", actor: "agent" }],
  });
  expect(records[0]!.relationships).toEqual([
    { type: "superseded-by", referenceId: expect.any(String) },
  ]);
  expect(records[1]).toMatchObject({
    status: "complementary",
    history: [{ status: "complementary", actor: "agent" }],
  });
  expect(records.flatMap((record) => record.history).every((event) => event.timestamp > 0)).toBe(true);

  await page.reload();
  await expect(page.getByText(/Reference classifications recorded/).last()).toBeVisible();
  const reloadedImages = page.getByTestId("message-user-image");
  await expectVisibleReferenceImages(reloadedImages);
  await page.screenshot({ path: testInfo.outputPath("classified-images-after-reload.png"), fullPage: true });
});
