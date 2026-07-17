import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";

test.use({ trace: "on" });

const REFERENCES = [
  { id: "workflow-ref-primary", color: { r: 19, g: 124, b: 189 } },
  { id: "workflow-ref-detail", color: { r: 47, g: 158, b: 68 } },
  { id: "workflow-ref-profile", color: { r: 242, g: 180, b: 24 } },
  { id: "workflow-ref-old", color: { r: 185, g: 47, b: 59 } },
] as const;

test("proves the complete retrievable evidence lifecycle", async ({ page }, testInfo) => {
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
    data: { title: "Retrievable evidence workflow", cadEnvironment: "build123d" },
  })).json() as { id: string };
  const referenceBytes = new Map<string, Buffer>();
  for (const [index, reference] of REFERENCES.entries()) {
    const bytes = await sharp({ create: { width: 96, height: 72, channels: 3, background: reference.color } }).png().toBuffer();
    referenceBytes.set(reference.id, bytes);
    const messageId = `workflow-message-${index}`;
    await page.request.post(`/api/conversations/${conversation.id}/messages`, {
      data: {
        id: messageId,
        seq: index,
        role: "user",
        contentJson: JSON.stringify({
          role: "user",
          content: [
            { type: "text", text: index === 0 ? "retrievable-evidence-workflow: four durable visual references" : `Reference ${index + 1}` },
            { type: "attachment-reference", attachmentId: reference.id, kind: "user-image", mimeType: "image/png" },
          ],
          timestamp: index + 1,
        }),
      },
    });
    const upload = await page.request.post(`/api/messages/${messageId}/attachments?id=${reference.id}&kind=user-image&mime=image/png`, {
      data: bytes,
      headers: { "content-type": "image/png" },
    });
    expect(upload.ok()).toBe(true);
  }

  const specifications = await page.request.post(`/api/conversations/${conversation.id}/source-specifications`, {
    headers: { "Idempotency-Key": "workflow-reference-specifications" },
    data: {
      specifications: [{
        id: "visual.primary",
        requirement: "Preserve the primary silhouette.",
        source: { attachmentId: "workflow-ref-primary", observation: "The primary attachment defines the silhouette." },
      }, {
        id: "visual.detail",
        requirement: "Preserve the visible surface detail.",
        source: { attachmentId: "workflow-ref-detail", observation: "The detail attachment defines the visible surface feature." },
      }, {
        id: "visual.profile",
        requirement: "Preserve the side profile.",
        source: { attachmentId: "workflow-ref-profile", observation: "The profile attachment defines the side silhouette." },
      }],
    },
  });
  expect(specifications.ok()).toBe(true);

  await page.goto("/");
  const composer = page.getByTestId("composer-input");
  await expect(composer).toBeEnabled();
  await expect(page.getByTestId("message-user-image")).toHaveCount(4);
  await composer.fill("Build from the active evidence, retrieve the earlier reference, and finish only after batched visual verification.");
  await page.getByTestId("composer-send").click();
  await expect(page.getByText("Premature CAD rejected until every uploaded reference is classified.")).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText("Was this result helpful?")).toBeVisible({ timeout: 120_000 });

  const classificationInputs = [
    { referenceId: "workflow-ref-primary", status: "active", purpose: "Primary silhouette", relationships: [], specificationIds: ["visual.primary"] },
    { referenceId: "workflow-ref-detail", status: "complementary", purpose: "Surface detail", relationships: [{ type: "complements", referenceId: "workflow-ref-primary" }], specificationIds: ["visual.detail"] },
    { referenceId: "workflow-ref-profile", status: "complementary", purpose: "Side profile", relationships: [{ type: "complements", referenceId: "workflow-ref-primary" }], specificationIds: ["visual.profile"] },
    { referenceId: "workflow-ref-old", status: "superseded", purpose: "Earlier silhouette", relationships: [{ type: "superseded-by", referenceId: "workflow-ref-primary" }], specificationIds: ["visual.primary"] },
  ];
  for (const input of classificationInputs) {
    const response = await page.request.post(`/api/conversations/${conversation.id}/reference-classifications`, {
      data: { ...input, rationale: `Workflow classification for ${input.referenceId}.` },
    });
    expect(response.ok()).toBe(true);
  }
  await page.reload();
  await expect(page.getByTestId("message-user-image")).toHaveCount(4);

  const classifications = await (await page.request.get(`/api/conversations/${conversation.id}/references`)).json() as Array<{
    referenceId: string; status: string;
  }>;
  expect(Object.fromEntries(classifications.map((item) => [item.referenceId, item.status]))).toEqual({
    "workflow-ref-primary": "active",
    "workflow-ref-detail": "complementary",
    "workflow-ref-profile": "complementary",
    "workflow-ref-old": "superseded",
  });
  await page.screenshot({ path: testInfo.outputPath("classification-and-premature-cad-rejection.png"), fullPage: true });

  await composer.fill("workflow-classify-ready workflow-retrieve workflow-build-first: retrieve the earlier evidence, then build revision one");
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("tool-call-card").filter({ hasText: /Recorded observation\s*Complete/ })).toBeVisible({ timeout: 120_000 });
  const leases = await (await page.request.get(`/api/conversations/${conversation.id}/inspection-leases`)).json() as Array<{
    status: string; evidence: Array<{ attachmentId: string }>; observation?: { facts: string[] };
  }>;
  expect(leases).toMatchObject([{
    status: "closed",
    evidence: [{ attachmentId: "workflow-ref-old" }],
    observation: { facts: ["The superseded reference used a narrower front silhouette."] },
  }]);
  await page.screenshot({ path: testInfo.outputPath("earlier-reference-retrieval-and-observation.png"), fullPage: true });

  await expect(page.getByText("Mismatch recovery paused with the first revision still current.").last()).toBeVisible({ timeout: 600_000 });
  await expect(page.getByText("Was this result helpful?")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("mismatch-recovery.png"), fullPage: true });
  await composer.fill("workflow-revise: correct the mismatch and repeat complete batched verification");
  await page.getByTestId("composer-send").click();
  await expect(page.getByText("Retrievable evidence workflow complete after reload-safe final verification.").last()).toBeVisible({ timeout: 600_000 });
  const batches = await (await page.request.get(`/api/conversations/${conversation.id}/visual-verification-batches`)).json() as Array<{
    artifactVersion: number; inspectionSheetId: string; batchIndex: number; batchCount: number;
    coveredReferenceIds: string[]; finalVerdict?: string;
  }>;
  expect(batches.map((batch) => [batch.artifactVersion, batch.batchIndex, batch.finalVerdict ?? null])).toEqual([
    [1, 0, null], [1, 1, "needs-revision"], [2, 0, null], [2, 1, "match"],
  ]);
  expect(batches.every((batch) => batch.batchCount === 2 && batch.coveredReferenceIds.length <= 2)).toBe(true);
  await expect(page.getByTestId("visual-verify-chip")).toHaveAttribute("data-verdict", "match");
  await page.screenshot({ path: testInfo.outputPath("successful-finalization.png"), fullPage: true });

  const lifecycle = await (await page.request.get(`/api/conversations/${conversation.id}/image-diagnostics`)).json() as {
    attachments: Array<{ attachmentId: string; hashPrefix: string; lifecycle: string; storageState: string }>;
  };
  expect(lifecycle.attachments.every((item) => item.storageState === "available")).toBe(true);
  expect(lifecycle.attachments.filter((item) => item.attachmentId.startsWith("workflow-ref")).map((item) => item.lifecycle)).toEqual([
    "active-reference", "complementary-reference", "complementary-reference", "superseded-reference",
  ]);
  expect(lifecycle.attachments.filter((item) => item.lifecycle === "historical-sheet")).toHaveLength(2);

  const capture = await (await page.request.get(`/api/test/fake-model-requests?conversationId=${conversation.id}`)).json() as {
    requests: Array<{
      sequence: number; imageCount: number; images: Array<{ hashPrefix: string }>;
      structuredRecords: Array<{ batchIndex: number; batchCount: number; artifactVersion: number; referenceIds: string[] }>;
    }>;
    exposure: {
      requestCount: number; totalImageExposures: number; peakImagesPerRequest: number; routineImageExposures: number;
      repeatedPixelsBaselineExposures: number; avoidedImageExposures: number;
    };
  };
  const hashFor = (id: string) => createHash("sha256").update(referenceBytes.get(id)!).digest("hex").slice(0, 12);
  expect(capture.requests[0]?.images.map((image) => image.hashPrefix).sort()).toEqual(REFERENCES.map((item) => hashFor(item.id)).sort());
  const batchRequests = capture.requests.filter((request) => request.structuredRecords.length > 0);
  expect(batchRequests).toHaveLength(4);
  expect(batchRequests.every((request) => request.imageCount >= 2 && request.imageCount <= 3)).toBe(true);
  expect(batchRequests.flatMap((request) => request.images).map((image) => image.hashPrefix)).not.toContain(hashFor("workflow-ref-old"));
  expect(capture.exposure).toMatchObject({ peakImagesPerRequest: 4 });
  expect(capture.exposure.routineImageExposures).toBeLessThan(capture.exposure.totalImageExposures);
  expect(capture.exposure.repeatedPixelsBaselineExposures).toBeGreaterThan(capture.exposure.totalImageExposures);
  expect(capture.exposure.avoidedImageExposures).toBe(
    capture.exposure.repeatedPixelsBaselineExposures - capture.exposure.totalImageExposures,
  );
  const attachmentHashes = new Map(lifecycle.attachments.map((item) => [item.attachmentId, item.hashPrefix]));
  for (const request of batchRequests) {
    const record = request.structuredRecords[0]!;
    const batchRecord = batches.find((item) =>
      item.artifactVersion === record.artifactVersion && item.batchIndex === record.batchIndex - 1)!;
    const expectedHashes = [
      attachmentHashes.get(batchRecord.inspectionSheetId)!,
      ...record.referenceIds.map((id) => attachmentHashes.get(id)!),
    ].sort();
    expect(request.images.map((image) => image.hashPrefix).sort()).toEqual(expectedHashes);
  }
  const oldExposures = capture.requests.filter((request) =>
    request.images.some((image) => image.hashPrefix === hashFor("workflow-ref-old")));
  const selectedLeaseExposures = oldExposures.filter((request) => request.imageCount === 1);
  expect(selectedLeaseExposures).toHaveLength(1);
  expect(selectedLeaseExposures[0]).toMatchObject({ structuredRecords: [] });
  expect(capture.requests.filter((request) => request.sequence > selectedLeaseExposures[0]!.sequence)
    .flatMap((request) => request.images).map((image) => image.hashPrefix)).not.toContain(hashFor("workflow-ref-old"));
  const sheetHashes = lifecycle.attachments.filter((item) => item.attachmentId === batches[0]?.inspectionSheetId || item.attachmentId === batches[2]?.inspectionSheetId);
  expect(sheetHashes).toHaveLength(2);
  const secondSheetSequence = capture.requests.find((request) =>
    request.images.some((image) => image.hashPrefix === sheetHashes[1]?.hashPrefix))?.sequence;
  expect(secondSheetSequence).toBeDefined();
  expect(capture.requests.filter((request) => request.sequence >= secondSheetSequence!).flatMap((request) => request.images)
    .map((image) => image.hashPrefix)).not.toContain(sheetHashes[0]!.hashPrefix);
  const firstSheetSequence = capture.requests.find((request) =>
    request.images.some((image) => image.hashPrefix === sheetHashes[0]?.hashPrefix))!.sequence;
  expect(capture.requests.filter((request) => request.sequence >= firstSheetSequence && request.structuredRecords.length === 0)
    .every((request) => request.imageCount <= 1)).toBe(true);

  const messages = await (await page.request.get(`/api/conversations/${conversation.id}/messages`)).json() as Array<{ contentJson: string }>;
  const persisted = messages.map((message) => message.contentJson).join("\n");
  expect(persisted).not.toContain('"type":"image"');
  expect(persisted).not.toContain(";base64,");
  expect(persisted).not.toMatch(/"data":"[A-Za-z0-9+/=]{32,}"/);
  mkdirSync(testInfo.outputDir, { recursive: true });
  writeFileSync(testInfo.outputPath("fake-model-request-captures.json"), JSON.stringify(capture, null, 2));
  writeFileSync(testInfo.outputPath("image-exposure-report.json"), JSON.stringify(capture.exposure, null, 2));
  writeFileSync(testInfo.outputPath("persisted-data-measurements.json"), JSON.stringify({
    messageCount: messages.length,
    persistedBytes: Buffer.byteLength(persisted),
    base64PayloadCount: 0,
    diagnostics: lifecycle,
  }, null, 2));

  await page.reload();
  await expect(page.getByTestId("message-user-image")).toHaveCount(4, { timeout: 60_000 });
  await expect(page.getByTestId("view-sheet-image")).toHaveCount(2, { timeout: 60_000 });
  await page.getByTestId("view-sheet-image").first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("post-reload-chat-history.png"), fullPage: true });

  const dataDir = process.env.CHAMFER_DATA_DIR;
  if (!dataDir) throw new Error("CHAMFER_DATA_DIR is required for broken-evidence proof");
  const db = new DatabaseSync(join(dataDir, "chamfer.db"));
  const oldBlob = db.prepare("SELECT blob_path FROM attachments WHERE id = 'workflow-ref-old'").get() as { blob_path: string };
  db.close();
  rmSync(join(dataDir, oldBlob.blob_path));
  const broken = await (await page.request.get(`/api/conversations/${conversation.id}/image-diagnostics`)).json() as {
    attachments: Array<{ attachmentId: string; storageState: string }>;
  };
  expect(broken.attachments.find((item) => item.attachmentId === "workflow-ref-old")?.storageState).toBe("missing");
  await page.reload();
  const missingEvidence = page.getByText("Attachment missing");
  await expect(missingEvidence).toHaveCount(2, { timeout: 60_000 });
  await expect(missingEvidence.first()).toBeVisible();
  await expect(missingEvidence.last()).toBeVisible();
  await missingEvidence.first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("broken-evidence.png"), fullPage: true });
});
