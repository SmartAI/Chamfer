import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";

const REFERENCE = readFileSync("packages/client/public/brand/chamfer-mark-512.png");

test("verifies a large active set across bounded deterministic requests", async ({ page }, testInfo) => {
  test.setTimeout(600_000);
  await page.request.put("/api/settings", {
    data: {
      modelJson: JSON.stringify({
        id: "chamfer-fake", name: "Chamfer Fake Model", api: "anthropic-messages", provider: "anthropic",
        baseUrl: "http://127.0.0.1/fake", reasoning: false, input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000,
        maxTokens: 4096, maxInputImages: 3,
      }),
    },
  });
  const conversation = await (await page.request.post("/api/conversations", {
    data: { title: "Batched visual verification" },
  })).json() as { id: string };
  const referenceIds = ["batch-ref-e", "batch-ref-a", "batch-ref-d", "batch-ref-b", "batch-ref-c"];
  for (const [index, referenceId] of referenceIds.entries()) {
    const messageId = `batch-reference-message-${index}`;
    await page.request.post(`/api/conversations/${conversation.id}/messages`, {
      data: {
        id: messageId,
        seq: index,
        role: "user",
        contentJson: JSON.stringify({
          role: "user",
          content: [
            { type: "text", text: index === 0 ? "batched-visual-verification-setup: seeded active visual references" : `Seeded reference ${referenceId}` },
            { type: "attachment-reference", attachmentId: referenceId, kind: "user-image", mimeType: "image/png" },
          ],
          timestamp: index + 1,
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
        purpose: `Visible form reference ${referenceId}`,
        relationships: [],
        rationale: "Defines visible proportions.",
        specificationLinks: [`visual.${referenceId}`],
      },
    });
  }

  await page.goto("/");
  const composer = page.getByTestId("composer-input");
  await expect(composer).toBeEnabled();
  await composer.fill("Build one current artifact and verify every active reference within the model image limit.");
  await page.getByTestId("composer-send").click();
  await expect(page.getByText("All batched visual evidence is covered by one synthesized match verdict.")).toBeVisible({ timeout: 600_000 });
  await expect(page.getByTestId("visual-verify-chip")).toHaveAttribute("data-verdict", "match");
  await expect(page.getByTestId("visual-verify-chip")).toContainText("5 refs");
  await page.screenshot({ path: testInfo.outputPath("batched-final-verdict.png"), fullPage: true });

  const batches = await (await page.request.get(`/api/conversations/${conversation.id}/visual-verification-batches`)).json() as Array<{
    artifactId: string;
    artifactVersion: number;
    inspectionSheetId: string;
    imageLimit: number;
    activeReferenceIds: string[];
    batchIndex: number;
    batchCount: number;
    coveredReferenceIds: string[];
    observations: Array<{ findings: string[] }>;
    finalVerdict?: string;
    synthesis?: string;
  }>;
  expect(batches.map((batch) => batch.coveredReferenceIds)).toEqual([
    ["batch-ref-a", "batch-ref-b"],
    ["batch-ref-c", "batch-ref-d"],
    ["batch-ref-e"],
  ]);
  expect(batches.map((batch) => batch.observations[0]?.findings[0]?.match(/carried (\d+) images/)?.[1])).toEqual(["3", "3", "2"]);
  expect(batches.every((batch) => batch.imageLimit === 3 && batch.batchCount === 3)).toBe(true);
  expect(new Set(batches.map((batch) => `${batch.artifactId}@${batch.artifactVersion}`)).size).toBe(1);
  expect(new Set(batches.map((batch) => batch.inspectionSheetId)).size).toBe(1);
  expect(batches[2]).toMatchObject({
    finalVerdict: "match",
    synthesis: "All 5 active references match the shared current inspection sheet across 3 deterministic requests.",
  });

  const replay = await (await page.request.get(`/api/conversations/${conversation.id}/visual-verification-batches`)).json();
  expect(JSON.stringify(replay)).toBe(JSON.stringify(batches));
});
