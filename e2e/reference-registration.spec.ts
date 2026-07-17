import { expect, test } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import sharp from "sharp";
import { startBuild123dConversation } from "./helpers";

let dimensionedView: Buffer;

test.beforeAll(async () => {
  dimensionedView = await sharp(Buffer.from(`
  <svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
    <rect width="512" height="512" fill="white"/>
    <rect x="140" y="140" width="232" height="232" fill="#111827"/>
    <line x1="140" y1="405" x2="140" y2="455" stroke="#111827" stroke-width="3"/>
    <line x1="372" y1="405" x2="372" y2="455" stroke="#111827" stroke-width="3"/>
    <line x1="140" y1="440" x2="372" y2="440" stroke="#111827" stroke-width="4"/>
    <path d="M140 440 l18 -9 v18 Z M372 440 l-18 -9 v18 Z" fill="#111827"/>
    <rect x="218" y="421" width="76" height="30" rx="4" fill="white"/>
    <text x="256" y="443" text-anchor="middle" font-family="Arial, sans-serif" font-size="22" fill="#111827">10 mm</text>
    <text x="24" y="38" font-family="Arial, sans-serif" font-size="18" fill="#334155">FRONT ORTHOGRAPHIC</text>
  </svg>
  `)).png().toBuffer();
});
const PERSPECTIVE_PHOTO = readFileSync("packages/client/public/brand/chamfer-mark-512.png");

test("does not load image processing during text-only startup", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("sidebar")).toBeVisible();
  const loadedResources = await page.evaluate(() =>
    performance.getEntriesByType("resource").map((entry) => entry.name),
  );
  expect(loadedResources.filter((name) => /opencv/i.test(name))).toEqual([]);
});

test("registers a dimensioned orthographic reference before deliverable CAD", async ({ page }, testInfo) => {
  test.setTimeout(600_000);
  await page.goto("/");
  await startBuild123dConversation(page);

  const composer = page.getByTestId("composer-input");
  await expect(composer).toBeEnabled();
  await composer.fill("image-plan-gate: build the 10 mm spacer from this dimensioned front orthographic view");
  await page.getByTestId("composer-file-input").setInputFiles({
    name: "spacer-front.png",
    mimeType: "image/png",
    buffer: dimensionedView,
  });
  await page.getByTestId("composer-send").click();

  const registration = page.getByTestId("reference-registration-card");
  await expect(registration).toBeVisible({ timeout: 120_000 });
  await expect(registration).toHaveAttribute("data-eligibility", "eligible");
  await expect(registration).toContainText("Front orthographic");
  await expect(registration).toContainText("10 mm");
  await page.getByTestId("reference-registration-toggle").click();
  await expect(page.getByTestId("reference-contour-preview")).toBeVisible();
  await expect(page.getByTestId("reference-registration")).toContainText("mm/px");

  const proofContract = page.getByTestId("proof-contract-card");
  await expect(proofContract).toBeVisible({ timeout: 120_000 });
  await expect(proofContract).toHaveAttribute("data-shape-proof-status", "required");
  await expect(page.getByText("Spacer complete", { exact: false }).first()).toBeVisible({ timeout: 600_000 });
  await expect(page.getByText("Done", { exact: true })).toBeVisible({ timeout: 600_000 });
  await page.screenshot({ path: testInfo.outputPath("eligible-orthographic-registration.png"), fullPage: true });

  const conversations = await (await page.request.get("/api/conversations")).json() as Array<{ id: string }>;
  const conversationId = conversations[0]!.id;
  const registrations = await (
    await page.request.get(`/api/conversations/${conversationId}/reference-registrations`)
  ).json() as Array<{
    registrationId: string;
    referenceId: string;
    revision: number;
    status: string;
    sourceRegion: object;
    eligibility: { status: string; reasons: string[] };
    uncertainty: { notes: string };
    geometry: {
      extraction: { status: string; extractor: { id: string; version: number } };
      mask: { width: number; height: number; rle: number[] };
      contour: { points: number[][]; areaPx2: number };
      scaleTransform: { physicalLengthMm: number; mmPerPixel: number };
    };
  }>;
  expect(registrations).toHaveLength(1);
  expect(registrations[0]).toMatchObject({
    revision: 1,
    status: "current",
    sourceRegion: { x: 0, y: 0, width: 1, height: 1 },
    eligibility: { status: "eligible", reasons: [] },
    geometry: {
      extraction: { status: "succeeded", extractor: { id: "opencv-js-contour", version: 1 } },
      scaleTransform: { physicalLengthMm: 10 },
    },
  });
  expect(registrations[0]!.geometry.mask.rle.reduce((sum, run) => sum + run, 0)).toBe(
    registrations[0]!.geometry.mask.width * registrations[0]!.geometry.mask.height,
  );
  expect(registrations[0]!.geometry.contour.points.length).toBeGreaterThanOrEqual(3);
  expect(registrations[0]!.geometry.contour.areaPx2).toBeGreaterThan(0);
  expect(registrations[0]!.geometry.scaleTransform.mmPerPixel).toBeGreaterThan(0);
  const registrationRecordPath = testInfo.outputPath("eligible-registration-record.json");
  writeFileSync(registrationRecordPath, JSON.stringify(registrations[0], null, 2));
  await testInfo.attach("eligible-registration-record.json", {
    path: registrationRecordPath,
    contentType: "application/json",
  });
  const contour = registrations[0]!.geometry.contour.points.map(([x, y]) => `${x},${y}`).join(" ");
  const contourPath = testInfo.outputPath("eligible-contour.svg");
  writeFileSync(contourPath, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${registrations[0]!.geometry.mask.width} ${registrations[0]!.geometry.mask.height}"><polygon points="${contour}" fill="#cffafe" stroke="#0891b2" stroke-width="2"/></svg>`);
  await testInfo.attach("eligible-contour.svg", {
    path: contourPath,
    contentType: "image/svg+xml",
  });

  const messages = await (
    await page.request.get(`/api/conversations/${conversationId}/messages`)
  ).json() as Array<{ seq: number; contentJson: string }>;
  const parsed = messages.map((message) => ({ seq: message.seq, value: JSON.parse(message.contentJson) as {
    role?: string;
    toolName?: string;
    isError?: boolean;
  } }));
  const registrationResult = parsed.find(({ value }) => value.role === "toolResult" && value.toolName === "register_reference_view");
  const firstDeliverable = parsed.find(({ value }) => value.role === "toolResult" && value.toolName === "run_build123d" && !value.isError);
  expect(registrationResult?.seq).toBeLessThan(firstDeliverable!.seq);

  const contractsBeforeChange = await (
    await page.request.get(`/api/conversations/${conversationId}/proof-contracts`)
  ).json() as Array<{
    status: string;
    derivation: { shapeProof: { status: string; registrations: Array<{ revision: number }> } };
  }>;
  expect(contractsBeforeChange).toMatchObject([{
    status: "current",
    derivation: { shapeProof: { status: "required", registrations: [{ revision: 1 }] } },
  }]);

  const current = registrations[0]!;
  const retryPayload = {
    referenceId: current.referenceId,
    sourceRegion: current.sourceRegion,
    projection: "orthographic",
    direction: "front",
    scaleAnchor: {
      specificationId: "overall-size",
      start: { x: 0.2734375, y: 0.859375 },
      end: { x: 0.7265625, y: 0.859375 },
      physicalLengthMm: 10,
    },
    visibleLandmarks: [{ id: "center-mark", label: "Visible center mark", position: { x: 0.5, y: 0.5 } }],
    uncertainty: { level: "low", notes: current.uncertainty.notes, occluded: false },
    geometry: current.geometry,
  };
  const exactRetry = await page.request.post(`/api/conversations/${conversationId}/reference-registrations`, {
    headers: { "Idempotency-Key": "e2e-natural-retry" },
    data: retryPayload,
  });
  expect(await exactRetry.json()).toMatchObject({ registrationId: current.registrationId, revision: 1 });

  const changed = await page.request.post(`/api/conversations/${conversationId}/reference-registrations`, {
    headers: { "Idempotency-Key": "e2e-registration-change" },
    data: {
      ...retryPayload,
      uncertainty: { ...retryPayload.uncertainty, notes: "Reload inspection confirmed the same source outline." },
    },
  });
  expect(await changed.json()).toMatchObject({ registrationId: current.registrationId, revision: 2, status: "current" });
  const contractsAfterChange = await (
    await page.request.get(`/api/conversations/${conversationId}/proof-contracts`)
  ).json() as Array<{ status: string; proofStatus: string }>;
  expect(contractsAfterChange).toMatchObject([{ status: "stale", proofStatus: "stale" }]);

  await page.reload();
  await expect(page.getByTestId("reference-registration-card")).toContainText("Revision 2");
  await expect(page.getByTestId("proof-contract-card")).toHaveCount(0);
});

test("keeps an unscaled perspective reference advisory with visible reasons", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  await page.goto("/");
  await startBuild123dConversation(page);

  const composer = page.getByTestId("composer-input");
  await expect(composer).toBeEnabled();
  await composer.fill("reference-registration-advisory: inspect this unscaled perspective photograph");
  await page.getByTestId("composer-file-input").setInputFiles({
    name: "perspective.png",
    mimeType: "image/png",
    buffer: PERSPECTIVE_PHOTO,
  });
  await page.getByTestId("composer-send").click();

  const registration = page.getByTestId("reference-registration-card");
  await expect(registration).toBeVisible({ timeout: 120_000 });
  await expect(registration).toHaveAttribute("data-eligibility", "advisory");
  await expect(registration).toContainText("Perspective reference");
  await expect(registration).toContainText("Unscaled");
  await page.getByTestId("reference-registration-toggle").click();
  const reasons = page.getByTestId("reference-registration-reasons");
  await expect(reasons).toContainText("Perspective projection");
  await expect(reasons).toContainText("Physical scale is not established");
  await registration.screenshot({ path: testInfo.outputPath("advisory-perspective-registration.png") });

  const conversations = await (await page.request.get("/api/conversations")).json() as Array<{ id: string }>;
  const advisory = await (
    await page.request.get(`/api/conversations/${conversations[0]!.id}/reference-registrations`)
  ).json() as Array<{ eligibility: { status: string; reasons: string[] } }>;
  expect(advisory).toMatchObject([{
    eligibility: {
      status: "advisory",
      reasons: [
        "Perspective projection cannot support physical shape proof.",
        "Physical scale is not established.",
      ],
    },
  }]);
  const advisoryRecordPath = testInfo.outputPath("advisory-registration-record.json");
  writeFileSync(advisoryRecordPath, JSON.stringify(advisory[0], null, 2));
  await testInfo.attach("advisory-registration-record.json", {
    path: advisoryRecordPath,
    contentType: "application/json",
  });

  await page.reload();
  await expect(page.getByTestId("reference-registration-card")).toHaveAttribute("data-eligibility", "advisory");
});
