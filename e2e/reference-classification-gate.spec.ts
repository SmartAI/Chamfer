import { expect, test, type Locator } from "@playwright/test";
import { readFileSync } from "node:fs";
import { startBuild123dConversation } from "./helpers";

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
  test.setTimeout(180_000);
  await page.goto("/");
  await startBuild123dConversation(page);
  const composer = page.getByTestId("composer-input");
  await expect(composer).toBeEnabled();
  await composer.fill("reference-classification-gate: use these primary and corrected drawings");
  await page.getByTestId("composer-file-input").setInputFiles([
    { name: "primary.png", mimeType: "image/png", buffer: PRIMARY_PNG },
    { name: "corrected-front.png", mimeType: "image/png", buffer: CORRECTED_PNG },
  ]);
  await page.getByTestId("composer-send").click();

  const rejectedRun = page
    .getByRole("button", { name: "Executing code Failed", exact: true })
    .locator("..");
  await expect(rejectedRun).toContainText("classify_reference", { timeout: 120_000 });
  await expect(rejectedRun).toContainText("unclassified");
  await expect(page.getByTitle("record_reference_specifications")).toHaveCount(2, {
    timeout: 120_000,
  });
  await expect(page.getByTitle("classify_reference")).toHaveCount(3, {
    timeout: 120_000,
  });
  await expect(page.getByTestId("tool-call-card").filter({ hasText: /Classified reference\s*Complete/ })).toHaveCount(3, {
    timeout: 120_000,
  });
  await expect(page.getByText(/Reference classifications recorded/).last()).toBeVisible({ timeout: 120_000 });
  const specifications = page.getByTestId("source-specifications-card");
  await expect(specifications).toContainText("2 active · 1 history");
  await page.getByTestId("source-specifications-toggle").click();
  await expect(page.getByTestId("source-specification")).toHaveCount(3);
  await expect(specifications).toContainText("primary drawing contains the overall dimension callouts");
  await expect(specifications).toContainText("corrected attachment shows the authoritative front orientation");
  await expect(specifications).toContainText("superseded");
  await expect(page.getByTestId("source-specification-region")).toHaveCount(3);
  const classifiedImages = page.getByTestId("message-user-image");
  await expectVisibleReferenceImages(classifiedImages);
  await page.screenshot({ path: testInfo.outputPath("classified-images-visible.png"), fullPage: true });

  const conversations = (await (await page.request.get("/api/conversations")).json()) as Array<{ id: string }>;
  const records = (await (
    await page.request.get(`/api/conversations/${conversations[0]!.id}/references`)
  ).json()) as Array<{
    status: string;
    specificationIds: string[];
    legacySpecificationLinks?: string[];
    relationships: Array<{ type: string; referenceId: string }>;
    history: Array<{ status: string; actor: string; timestamp: number; specificationIds: string[] }>;
  }>;
  expect(records).toHaveLength(2);
  expect(records[0]).toMatchObject({
    status: "superseded",
    specificationIds: ["primary-dimensions", "front-orientation-v2"],
    history: [
      { status: "active", actor: "agent", specificationIds: ["primary-dimensions", "front-orientation-v1"] },
      { status: "superseded", actor: "agent", specificationIds: ["primary-dimensions", "front-orientation-v2"] },
    ],
  });
  expect(records[0]!.relationships).toEqual([
    { type: "superseded-by", referenceId: expect.any(String) },
  ]);
  expect(records[1]).toMatchObject({
    status: "complementary",
    specificationIds: ["front-orientation-v2"],
    history: [{ status: "complementary", actor: "agent", specificationIds: ["front-orientation-v2"] }],
  });
  expect(records.flatMap((record) => record.history).every((event) => event.timestamp > 0)).toBe(true);
  expect(records.every((record) => record.legacySpecificationLinks === undefined)).toBe(true);

  const persistedSpecifications = await (
    await page.request.get(`/api/conversations/${conversations[0]!.id}/source-specifications`)
  ).json() as Array<{
    id: string;
    status: string;
    supersedesSpecificationId?: string;
    supersededBySpecificationId?: string;
    source: { attachmentId: string; observation: string; region?: object };
  }>;
  expect(persistedSpecifications).toMatchObject([
    { id: "primary-dimensions", status: "active", source: { attachmentId: records[0]!.referenceId } },
    {
      id: "front-orientation-v1",
      status: "superseded",
      supersededBySpecificationId: "front-orientation-v2",
      source: { attachmentId: records[0]!.referenceId },
    },
    {
      id: "front-orientation-v2",
      status: "active",
      supersedesSpecificationId: "front-orientation-v1",
      source: { attachmentId: records[1]!.referenceId },
    },
  ]);
  const sanitizedProjection = JSON.stringify({ records, persistedSpecifications });
  expect(sanitizedProjection).not.toContain("data:image");
  expect(sanitizedProjection).not.toContain("/Users/");

  const dangling = await page.request.post(`/api/conversations/${conversations[0]!.id}/reference-classifications`, {
    headers: { "Idempotency-Key": "dangling-e2e-classification" },
    data: {
      referenceId: records[1]!.referenceId,
      status: "complementary",
      purpose: "Invalid dangling classification",
      relationships: [{ type: "complements", referenceId: records[0]!.referenceId }],
      rationale: "Regression attempt using the old string-only workflow.",
      specificationLinks: ["plan.spec_sheet.dangling"],
    },
  });
  expect(dangling.status()).toBe(400);
  expect(await dangling.text()).toContain("does not exist");

  const correction = persistedSpecifications.find((specification) => specification.id === "front-orientation-v2")!;
  const exactRetry = await page.request.post(`/api/conversations/${conversations[0]!.id}/source-specifications`, {
    headers: { "Idempotency-Key": "reference-corrected-specification" },
    data: {
      specifications: [{
        id: correction.id,
        requirement: "The part front must follow the corrected orientation view.",
        source: correction.source,
        supersedesSpecificationId: correction.supersedesSpecificationId,
      }],
    },
  });
  expect(exactRetry.ok()).toBe(true);
  expect(await exactRetry.json()).toEqual([correction]);

  await page.reload();
  await expect(page.getByText(/Reference classifications recorded/).last()).toBeVisible();
  const reloadedImages = page.getByTestId("message-user-image");
  await expectVisibleReferenceImages(reloadedImages);
  await expect(page.getByTestId("source-specifications-card")).toContainText("2 active · 1 history");
  await page.getByTestId("source-specifications-toggle").click();
  await expect(page.getByTestId("source-specification")).toHaveCount(3);
  await page.screenshot({ path: testInfo.outputPath("classified-images-after-reload.png"), fullPage: true });
});
