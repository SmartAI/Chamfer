import { expect, test } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const REFERENCE_PNG = readFileSync("packages/client/public/brand/chamfer-mark-512.png");

test("recovers an interrupted inspection lease, records observations, then evicts pixels", async ({ page }, testInfo) => {
  await page.goto("/");
  await page.getByTestId("sidebar").getByRole("button", { name: "New chat", exact: true }).first().click();
  const composer = page.getByTestId("composer-input");
  await expect(composer).toBeEnabled();
  await composer.fill("inspection-lease-workflow: preserve this earlier profile as evidence");
  await page.getByTestId("composer-file-input").setInputFiles({
    name: "earlier-profile.png",
    mimeType: "image/png",
    buffer: REFERENCE_PNG,
  });
  await page.getByTestId("composer-send").click();
  await expect(page.getByText("Reference classified and ready for later inspection.")).toBeVisible({ timeout: 120_000 });

  await composer.fill("lease-open: inspect the earlier profile now");
  await page.getByTestId("composer-send").click();
  await expect(page.getByRole("button", { name: "inspect_evidence Complete", exact: true })).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText("Inspection interrupted with its durable lease still open.").last()).toBeVisible();
  const inspectedImages = page.getByTestId("inspection-evidence-image");
  await expect(inspectedImages).toHaveCount(1);
  await expect(inspectedImages.first()).toBeVisible();
  const inspectedBounds = await inspectedImages.first().boundingBox();
  expect(inspectedBounds?.width).toBeGreaterThanOrEqual(80);
  expect(inspectedBounds?.height).toBeGreaterThanOrEqual(80);

  const conversations = await (await page.request.get("/api/conversations")).json() as Array<{ id: string }>;
  const conversationId = conversations[0]!.id;
  const openBeforeReload = await (
    await page.request.get(`/api/conversations/${conversationId}/inspection-leases?status=open`)
  ).json() as Array<{ id: string; evidence: Array<{ attachmentId: string }> }>;
  expect(openBeforeReload).toHaveLength(1);
  expect(openBeforeReload[0]!.evidence).toHaveLength(1);
  await page.screenshot({ path: testInfo.outputPath("lease-open-before-reload.png"), fullPage: true });

  await page.reload();
  await expect(page.getByText("Inspection interrupted with its durable lease still open.").last()).toBeVisible();
  await composer.fill("lease-recover: record the recovered visual evidence");
  await page.getByTestId("composer-send").click();
  await expect(page.getByRole("button", { name: "record_inspection_observation Complete", exact: true })).toBeVisible({
    timeout: 120_000,
  });
  await expect(page.getByText("Recovered inspection recorded and pixels evicted.")).toBeVisible();
  expect(await (
    await page.request.get(`/api/conversations/${conversationId}/inspection-leases?status=open`)
  ).json()).toEqual([]);
  const allLeases = await (
    await page.request.get(`/api/conversations/${conversationId}/inspection-leases`)
  ).json() as Array<{ status: string; observation?: { facts: string[] }; evidence: Array<{ attachmentId: string }> }>;
  expect(allLeases).toMatchObject([{
    status: "closed",
    observation: { facts: ["The profile has a wider flange around the central body."] },
  }]);

  await composer.fill("lease-count: confirm no inspection pixels remain");
  await page.getByTestId("composer-send").click();
  await expect(page.getByText("Lease context contains 0 native images.")).toBeVisible({ timeout: 120_000 });
  await page.screenshot({ path: testInfo.outputPath("lease-closed-pixels-evicted.png"), fullPage: true });

  const dataDir = process.env.CHAMFER_DATA_DIR;
  if (!dataDir) throw new Error("CHAMFER_DATA_DIR is required for missing-blob browser evidence");
  const db = new DatabaseSync(join(dataDir, "chamfer.db"));
  const attachmentId = allLeases[0]!.evidence[0]!.attachmentId;
  const blob = db.prepare("SELECT blob_path FROM attachments WHERE id = ?").get(attachmentId) as { blob_path: string };
  db.close();
  rmSync(join(dataDir, blob.blob_path));

  await composer.fill("lease-unavailable: inspect the same missing evidence again");
  await page.getByTestId("composer-send").click();
  const failed = page.getByRole("button", { name: "inspect_evidence Failed", exact: true }).last().locator("..");
  await expect(failed).toContainText(`evidence ${attachmentId} is missing`, { timeout: 120_000 });
  expect(await (
    await page.request.get(`/api/conversations/${conversationId}/inspection-leases?status=open`)
  ).json()).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("missing-evidence-visible.png"), fullPage: true });
});
