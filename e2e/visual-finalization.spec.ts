import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";

const REFERENCE = readFileSync("packages/client/public/brand/chamfer-mark-512.png");

test("blocks stale or mismatched visual finalization until current evidence matches", async ({ page }, testInfo) => {
  test.setTimeout(600_000);
  const conversation = await (await page.request.post("/api/conversations", {
    data: { title: "Visual finalization evidence", cadEnvironment: "build123d" },
  })).json() as { id: string };
  const referenceId = `visual-reference-${conversation.id}`;
  const messageId = `visual-reference-message-${conversation.id}`;
  await page.request.post(`/api/conversations/${conversation.id}/messages`, {
    data: {
      id: messageId,
      seq: 0,
      role: "user",
      contentJson: JSON.stringify({
        role: "user",
        content: [
          { type: "text", text: "visual-finalization-setup: seeded active form reference" },
          { type: "attachment-reference", attachmentId: referenceId, kind: "user-image", mimeType: "image/png" },
        ],
        timestamp: Date.now(),
      }),
    },
  });
  await page.request.post(`/api/messages/${messageId}/attachments?id=${referenceId}&kind=user-image&mime=image/png`, {
    data: REFERENCE,
    headers: { "content-type": "image/png" },
  });
  await page.request.post(`/api/conversations/${conversation.id}/reference-classifications`, {
    data: {
      referenceId,
      status: "active",
      purpose: "Primary form reference",
      relationships: [],
      rationale: "The image defines the requested visible proportions.",
      specificationIds: [],
      noSpecificationReason: "This fixture provides qualitative form guidance without a calibrated dimension.",
    },
  });
  await page.goto("/");
  const composer = page.getByTestId("composer-input");
  await expect(composer).toBeEnabled();

  await composer.fill("visual-finalization-build: build and visually verify the current design");
  await page.getByTestId("composer-send").click();
  await expect(page.getByText("Corrected revision complete with current visual match evidence.")).toBeVisible({ timeout: 600_000 });
  await expect(page.getByTestId("visual-nudge-chip")).toHaveCount(3);
  await expect(page.getByTestId("visual-verify-chip")).toHaveAttribute("data-verdict", "match");
  await expect(page.getByTestId("visual-verify-chip")).toContainText("1 refs");
  await page.screenshot({ path: testInfo.outputPath("current-visual-match.png"), fullPage: true });

  await composer.fill("visual-finalization-new-revision: make one more gate-passed CAD revision");
  await page.getByTestId("composer-send").click();
  await expect(page.getByText("Newest CAD revision visually verified against the active reference.")).toBeVisible({ timeout: 600_000 });
  await expect(page.getByTestId("visual-nudge-chip")).toHaveCount(4);
  await page.screenshot({ path: testInfo.outputPath("stale-verdict-blocked-and-refreshed.png"), fullPage: true });

  const records = await (await page.request.get(`/api/conversations/${conversation.id}/visual-verifications`)).json() as Array<{
    artifactId: string; artifactVersion: number; inspectionSheetId: string; verdict: string; coveredReferenceIds: string[];
  }>;
  expect(records.map((record) => record.verdict)).toEqual(["needs-revision", "match", "match"]);
  expect(new Set(records.map((record) => record.artifactId)).size).toBe(3);
  expect(new Set(records.map((record) => record.inspectionSheetId)).size).toBe(3);
  expect(records.every((record) => record.coveredReferenceIds.length === 1)).toBe(true);

  const batches = await (await page.request.get(`/api/conversations/${conversation.id}/visual-verification-batches`)).json() as Array<{
    batchIndex: number;
    batchCount: number;
    coveredReferenceIds: string[];
    observations: Array<{ findings: string[] }>;
    finalVerdict?: string;
  }>;
  expect(batches).toHaveLength(3);
  expect(batches.every((batch) =>
    batch.batchIndex === 0 && batch.batchCount === 1 &&
    batch.coveredReferenceIds.join(",") === referenceId &&
    batch.observations[0]?.findings[0]?.includes("request carried 2 images") &&
    batch.finalVerdict !== undefined)).toBe(true);
});
