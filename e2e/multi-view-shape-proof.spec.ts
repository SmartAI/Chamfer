import { expect, test, type TestInfo } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import sharp from "sharp";

let frontView: Buffer;
let rightView: Buffer;

test.use({ trace: "on" });

function drawing(outline: string, label: string): Promise<Buffer> {
  return sharp(Buffer.from(`
  <svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
    <rect width="512" height="512" fill="white"/>
    <path d="${outline}" fill="#111827"/>
    <line x1="140" y1="405" x2="140" y2="455" stroke="#111827" stroke-width="3"/>
    <line x1="372" y1="405" x2="372" y2="455" stroke="#111827" stroke-width="3"/>
    <line x1="140" y1="440" x2="372" y2="440" stroke="#111827" stroke-width="4"/>
    <path d="M140 440 l18 -9 v18 Z M372 440 l-18 -9 v18 Z" fill="#111827"/>
    <rect x="218" y="421" width="76" height="30" rx="4" fill="white"/>
    <text x="256" y="443" text-anchor="middle" font-family="Arial, sans-serif" font-size="22" fill="#111827">10 mm</text>
    <text x="24" y="38" font-family="Arial, sans-serif" font-size="18" fill="#334155">${label}</text>
  </svg>
  `)).png().toBuffer();
}

test.beforeAll(async () => {
  frontView = await drawing("M140 140 H372 V372 H140 Z", "FRONT ORTHOGRAPHIC");
  rightView = await drawing("M140 140 H332 L372 180 V372 H140 Z", "RIGHT ORTHOGRAPHIC");
});

interface EncodedMask {
  width: number;
  height: number;
  rle: number[];
}

interface ShapeView {
  status: "passed" | "failed" | "error";
  registration: { id: string; referenceId: string; direction: string };
  render: { mask: EncodedMask };
  metrics?: {
    silhouetteIou: number;
    symmetricContourDistanceMm: number;
    landmarks: Array<{ id: string; status: string; positionErrorMm?: number }>;
  };
  worst: { metric: string; landmarkId?: string; detail: string };
}

interface ShapeProof {
  status: "passed" | "failed" | "error";
  policy: object;
  evaluator: object;
  contract: object;
  artifact: object;
  coverage: {
    activeReferenceIds: string[];
    requiredRegistrationIds: string[];
    batches: string[][];
  };
  views: ShapeView[];
  worst: { metric: string; landmarkId?: string; detail: string };
}

function decodeMask(mask: EncodedMask): Buffer {
  const output = Buffer.alloc(mask.width * mask.height);
  let offset = 0;
  let foreground = false;
  for (const run of mask.rle) {
    if (foreground) output.fill(255, offset, offset + run);
    offset += run;
    foreground = !foreground;
  }
  return output;
}

async function attachMask(testInfo: TestInfo, name: string, mask: EncodedMask) {
  const pixels = decodeMask(mask);
  const foreground: Array<[number, number]> = [];
  for (let y = 0; y < mask.height; y += 1) {
    for (let x = 0; x < mask.width; x += 1) {
      if (pixels[y * mask.width + x]! > 0) foreground.push([x, y]);
    }
  }
  expect(foreground.length, `${name} must contain visible evidence pixels`).toBeGreaterThan(0);
  expect(foreground.length, `${name} must not be a filled blank frame`).toBeLessThan(mask.width * mask.height);
  const xs = foreground.map(([x]) => x);
  const ys = foreground.map(([, y]) => y);
  expect(Math.min(...xs), `${name} must have left framing margin`).toBeGreaterThan(0);
  expect(Math.max(...xs), `${name} must have right framing margin`).toBeLessThan(mask.width - 1);
  expect(Math.min(...ys), `${name} must have top framing margin`).toBeGreaterThan(0);
  expect(Math.max(...ys), `${name} must have bottom framing margin`).toBeLessThan(mask.height - 1);
  const path = testInfo.outputPath(`${name}.png`);
  await sharp(pixels, { raw: { width: mask.width, height: mask.height, channels: 1 } }).png().toFile(path);
  await testInfo.attach(`${name}.png`, { path, contentType: "image/png" });
}

test("requires all registered views and landmarks, then refreshes coverage after repair", async ({ page }, testInfo) => {
  test.setTimeout(600_000);
  await page.goto("/");
  await page.getByTestId("sidebar").getByRole("button", { name: "New chat", exact: true }).first().click();
  await page.getByRole("dialog", { name: "Choose a CAD environment" })
    .getByRole("button", { name: "Start conversation" }).click();

  const composer = page.getByTestId("composer-input");
  await expect(composer).toBeEnabled();
  await composer.fill("multi-view-shape-proof-flow: build this 10 mm spacer from both views");
  await page.getByTestId("composer-file-input").setInputFiles([{
    name: "spacer-front.png",
    mimeType: "image/png",
    buffer: frontView,
  }, {
    name: "spacer-right.png",
    mimeType: "image/png",
    buffer: rightView,
  }]);
  await page.getByTestId("composer-send").click();

  const cards = page.getByTestId("tool-shape-proof");
  await expect(cards.first()).toHaveAttribute("data-status", "failed", { timeout: 300_000 });
  await expect(cards.first()).toContainText("1/2 views");
  await expect(cards.first()).toContainText("right-chamfer-midpoint");
  await expect(cards.first().getByTestId("tool-shape-proof-view")).toHaveCount(2);
  await expect(page.getByTestId("proof-report-card")).toHaveAttribute(
    "data-proof-report-status",
    /failed|stale/,
  );
  await expect(page.getByTestId("proof-status-chip")).not.toHaveAttribute("data-status", "proven");
  await expect(page.getByTestId("export-proof-label")).toContainText("Unproven");
  await page.screenshot({ path: testInfo.outputPath("wrong-shape-rejected-unproven.png"), fullPage: true });
  await expect(page.getByText("refreshed multi-view shape proof", { exact: false }).first()).toBeVisible({ timeout: 600_000 });
  await expect(cards).toHaveCount(2);
  await expect(cards.last()).toHaveAttribute("data-status", "passed");
  await expect(cards.last()).toContainText("2/2 views");
  await expect(page.getByTestId("proof-report-card")).toHaveAttribute(
    "data-proof-report-status",
    "proven",
  );
  await expect(page.getByTestId("proof-status-chip")).toHaveAttribute("data-status", "proven");
  await expect(page.getByTestId("export-proof-label")).toHaveAttribute("data-proof-state", "proven");
  await expect(page.getByTestId("export-proof-label")).toContainText("Proven");

  await page.getByTestId("proof-report-card").getByRole("button", { expanded: false }).click();
  await expect(page.getByTestId("proof-report-registration-details")).toContainText("front");
  await expect(page.getByTestId("proof-report-registration-details")).toContainText("right");
  await expect(page.getByTestId("proof-report-shape-details")).toContainText("IoU");
  await expect(page.getByTestId("proof-report-visual-details")).toContainText("2 covered references");
  await page.getByTestId("proof-report-card").screenshot({ path: testInfo.outputPath("proven-proof-report-details.png") });
  await page.getByTestId("proof-report-registration-details").scrollIntoViewIfNeeded();
  await page.getByTestId("proof-report-card").screenshot({ path: testInfo.outputPath("proven-proof-report-provenance.png") });

  await cards.first().screenshot({ path: testInfo.outputPath("failed-multi-view-shape-proof-card.png") });
  await cards.last().screenshot({ path: testInfo.outputPath("passed-multi-view-shape-proof-card.png") });
  await page.screenshot({ path: testInfo.outputPath("multi-view-shape-proof-repair.png"), fullPage: true });

  const conversations = await (await page.request.get("/api/conversations")).json() as Array<{ id: string }>;
  const conversationId = conversations[0]!.id;
  const messages = await (
    await page.request.get(`/api/conversations/${conversationId}/messages`)
  ).json() as Array<{ contentJson: string }>;
  const parsed = messages.map((message) => JSON.parse(message.contentJson) as {
    role?: string;
    toolName?: string;
    toolCallId?: string;
    isError?: boolean;
    details?: {
      gate?: { status?: string };
      shapeProof?: ShapeProof;
      inspectionSheet?: { attachmentId?: string };
    };
  });
  const wrong = parsed.find((message) => message.toolCallId === "multi-view-shape-wrong");
  const falseFinish = parsed.find((message) => message.toolCallId === "multi-view-shape-false-finish");
  const corrected = parsed.find((message) => message.toolCallId === "multi-view-shape-corrected");
  expect(wrong).toMatchObject({
    role: "toolResult",
    toolName: "run_build123d",
    isError: false,
    details: {
      gate: { status: "passed" },
      shapeProof: { status: "failed" },
      inspectionSheet: { attachmentId: expect.any(String) },
    },
  });
  expect(falseFinish).toMatchObject({ role: "toolResult", toolName: "revise_plan", isError: true });
  expect(corrected).toMatchObject({
    role: "toolResult",
    toolName: "run_build123d",
    isError: false,
    details: { gate: { status: "passed" }, shapeProof: { status: "passed" } },
  });

  const failedProof = wrong!.details!.shapeProof!;
  const passedProof = corrected!.details!.shapeProof!;
  const failedFront = failedProof.views.find((view) => view.registration.direction === "front")!;
  const failedRight = failedProof.views.find((view) => view.registration.direction === "right")!;
  expect(failedFront.status).toBe("passed");
  expect(failedRight.status).toBe("failed");
  expect(failedRight.metrics!.symmetricContourDistanceMm).toBeGreaterThan(0);
  expect(failedRight.metrics!.landmarks).toEqual([expect.objectContaining({
    id: "right-chamfer-midpoint",
    status: "failed",
    positionErrorMm: expect.any(Number),
  })]);
  expect(failedProof.worst).toMatchObject({
    metric: "landmark-position",
    landmarkId: "right-chamfer-midpoint",
    detail: expect.stringContaining("Worst right view"),
  });
  expect(passedProof.views).toHaveLength(2);
  expect(passedProof.views.every((view) => view.status === "passed")).toBe(true);
  expect(passedProof.policy).toEqual(failedProof.policy);
  expect(passedProof.evaluator).toEqual(failedProof.evaluator);
  expect(passedProof.contract).toEqual(failedProof.contract);
  expect(passedProof.coverage.batches).toEqual(failedProof.coverage.batches);
  expect(passedProof.coverage.requiredRegistrationIds).toEqual(failedProof.coverage.requiredRegistrationIds);
  expect(passedProof.artifact).not.toEqual(failedProof.artifact);

  const registrations = await (
    await page.request.get(`/api/conversations/${conversationId}/reference-registrations`)
  ).json() as Array<{ direction: string; geometry: { mask: EncodedMask } }>;
  for (const registration of registrations) {
    await attachMask(testInfo, `registered-${registration.direction}-source`, registration.geometry.mask);
  }
  for (const view of failedProof.views) await attachMask(testInfo, `failed-${view.registration.direction}-render`, view.render.mask);
  for (const view of passedProof.views) await attachMask(testInfo, `passed-${view.registration.direction}-render`, view.render.mask);
  const metricsPath = testInfo.outputPath("multi-view-shape-proof-metrics.json");
  writeFileSync(metricsPath, JSON.stringify({ failed: failedProof, passed: passedProof }, null, 2));
  await testInfo.attach("multi-view-shape-proof-metrics.json", { path: metricsPath, contentType: "application/json" });

  const reports = await (
    await page.request.get(`/api/conversations/${conversationId}/proof-reports`)
  ).json() as Array<{
    reportId: string;
    status: string;
    acceptedPlan: { planId: string; criteriaRevision: number };
    proofContract: { contractId: string; revision: number };
    cadArtifact: { id: string; version: number };
    engineering: { evidenceId: string };
    referenceRegistrations: Array<{ registrationId: string; referenceId: string; revision: number }>;
    shapeProof: { state: string; record?: ShapeProof };
    visualVerification: { state: string; record?: { id: string; artifactId: string; artifactVersion: number; coveredReferenceIds: string[] } };
  }>;
  expect(reports).toHaveLength(2);
  expect(reports[0]).toMatchObject({ status: "stale", engineering: { evidenceId: "multi-view-shape-wrong" } });
  const provenReport = reports[1]!;
  expect(provenReport).toMatchObject({
    status: "proven",
    engineering: { evidenceId: "multi-view-shape-corrected" },
    shapeProof: { state: "proven", record: { status: "passed" } },
    visualVerification: { state: "proven", record: { artifactId: provenReport.cadArtifact.id, artifactVersion: provenReport.cadArtifact.version } },
  });
  expect(provenReport.referenceRegistrations).toHaveLength(2);
  expect(provenReport.shapeProof.record!.artifact).toEqual({
    id: provenReport.cadArtifact.id,
    version: provenReport.cadArtifact.version,
  });
  expect(provenReport.visualVerification.record!.coveredReferenceIds.sort()).toEqual(
    provenReport.referenceRegistrations.map((registration) => registration.referenceId).sort(),
  );

  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("proof-report-download").click();
  const download = await downloadPromise;
  const reportPath = testInfo.outputPath("image-proof-report.json");
  await download.saveAs(reportPath);
  const downloaded = JSON.parse(readFileSync(reportPath, "utf8")) as typeof provenReport;
  expect(downloaded.reportId).toBe(provenReport.reportId);
  expect(downloaded.cadArtifact).toEqual(provenReport.cadArtifact);
  await testInfo.attach("image-proof-report.json", { path: reportPath, contentType: "application/json" });

  const provenExportPromise = page.waitForEvent("download");
  await page.getByTestId("export-step").click();
  expect((await provenExportPromise).suggestedFilename()).toBe("proven-model.step");

  const artifacts = await (
    await page.request.get(`/api/conversations/${conversationId}/artifacts`)
  ).json() as Array<{ pySource: string }>;
  const staleResponse = await page.request.post(`/api/conversations/${conversationId}/artifacts`, {
    data: { pySource: artifacts.at(-1)!.pySource, paramsJson: null },
  });
  expect(staleResponse.ok()).toBe(true);
  await page.reload();
  await expect(page.getByTestId("proof-report-card")).toHaveAttribute("data-proof-report-status", "stale", { timeout: 60_000 });
  await expect(page.getByTestId("proof-status-chip")).toHaveAttribute("data-status", "stale");
  await expect(page.getByTestId("export-proof-label")).toContainText("Unproven");
  await expect(page.getByTestId("viewer-booting")).toBeHidden({ timeout: 600_000 });
  await expect(page.getByTestId("viewer-rendering")).toBeHidden({ timeout: 600_000 });
  await page.screenshot({ path: testInfo.outputPath("stale-image-proof-report.png"), fullPage: true });
});
