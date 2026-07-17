import { expect, test, type TestInfo } from "@playwright/test";
import { writeFileSync } from "node:fs";
import sharp from "sharp";

let dimensionedView: Buffer;

test.use({ trace: "on" });

test.beforeAll(async () => {
  dimensionedView = await sharp(Buffer.from(`
  <svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
    <rect width="512" height="512" fill="white"/>
    <path d="M140 140 H332 L372 180 V372 H140 Z" fill="#111827"/>
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

interface EncodedMask {
  width: number;
  height: number;
  rle: number[];
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
  const path = testInfo.outputPath(`${name}.png`);
  await sharp(decodeMask(mask), { raw: { width: mask.width, height: mask.height, channels: 1 } }).png().toFile(path);
  await testInfo.attach(`${name}.png`, { path, contentType: "image/png" });
}

test("rejects a scalar-valid wrong silhouette, preserves diagnostics, repairs, and passes unchanged policy", async ({ page }, testInfo) => {
  test.setTimeout(600_000);
  await page.goto("/");
  await page.getByTestId("sidebar").getByRole("button", { name: "New chat", exact: true }).first().click();
  await page.getByRole("dialog", { name: "Choose a CAD environment" })
    .getByRole("button", { name: "Start conversation" }).click();

  const composer = page.getByTestId("composer-input");
  await expect(composer).toBeEnabled();
  await composer.fill("single-view-shape-proof-flow: build this 10 mm chamfered spacer");
  await page.getByTestId("composer-file-input").setInputFiles({
    name: "chamfered-spacer-front.png",
    mimeType: "image/png",
    buffer: dimensionedView,
  });
  await page.getByTestId("composer-send").click();

  const shapeProofs = page.getByTestId("tool-shape-proof");
  await expect(shapeProofs.first()).toHaveAttribute("data-status", "failed", { timeout: 300_000 });
  await expect(shapeProofs.first()).toContainText("Silhouette IoU");
  await expect(shapeProofs.first()).toContainText("Registered view");
  await expect(page.getByText("The corrected spacer is complete", { exact: false }).first()).toBeVisible({ timeout: 600_000 });
  await expect(shapeProofs).toHaveCount(2);
  await expect(shapeProofs.last()).toHaveAttribute("data-status", "passed");
  await expect(page.getByText("Revised plan", { exact: true }).last()).toBeVisible();
  await shapeProofs.first().screenshot({ path: testInfo.outputPath("failed-shape-proof-card.png") });
  await shapeProofs.last().screenshot({ path: testInfo.outputPath("passed-shape-proof-card.png") });
  await page.screenshot({ path: testInfo.outputPath("shape-proof-repair-flow.png"), fullPage: true });

  const conversations = await (await page.request.get("/api/conversations")).json() as Array<{ id: string }>;
  const conversationId = conversations[0]!.id;
  const messages = await (
    await page.request.get(`/api/conversations/${conversationId}/messages`)
  ).json() as Array<{ seq: number; contentJson: string }>;
  const parsed = messages.map((message) => ({ seq: message.seq, value: JSON.parse(message.contentJson) as {
    role?: string;
    toolName?: string;
    toolCallId?: string;
    isError?: boolean;
    content?: Array<{ type?: string; kind?: string }>;
    details?: {
      gate?: { status?: string };
      inspectionSheet?: { attachmentId?: string };
      shapeProof?: {
        status: string;
        policy: object;
        evaluator: object;
        contract: object;
        registration: object;
        artifact: object;
        thresholds: object;
        metrics?: object;
        render: { mask: EncodedMask };
      };
    };
  } }));
  const wrong = parsed.find(({ value }) => value.toolCallId === "single-view-shape-wrong")?.value;
  const falseFinish = parsed.find(({ value }) => value.toolCallId === "single-view-shape-false-finish")?.value;
  const corrected = parsed.find(({ value }) => value.toolCallId === "single-view-shape-corrected")?.value;
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
  expect(wrong?.content?.some((block) => block.type === "attachment-reference" && block.kind === "view-sheet")).toBe(true);
  expect(falseFinish).toMatchObject({ role: "toolResult", toolName: "revise_plan", isError: true });
  expect(corrected).toMatchObject({
    role: "toolResult",
    toolName: "run_build123d",
    isError: false,
    details: { gate: { status: "passed" }, shapeProof: { status: "passed" } },
  });

  const failedProof = wrong!.details!.shapeProof!;
  const passedProof = corrected!.details!.shapeProof!;
  expect(passedProof.policy).toEqual(failedProof.policy);
  expect(passedProof.evaluator).toEqual(failedProof.evaluator);
  expect(passedProof.contract).toEqual(failedProof.contract);
  expect(passedProof.registration).toEqual(failedProof.registration);
  expect(passedProof.thresholds).toEqual(failedProof.thresholds);
  expect(passedProof.artifact).not.toEqual(failedProof.artifact);

  const registrations = await (
    await page.request.get(`/api/conversations/${conversationId}/reference-registrations`)
  ).json() as Array<{ geometry: { mask: EncodedMask } }>;
  await attachMask(testInfo, "registered-source-mask", registrations[0]!.geometry.mask);
  await attachMask(testInfo, "wrong-render-mask", failedProof.render.mask);
  await attachMask(testInfo, "corrected-render-mask", passedProof.render.mask);
  const metricPath = testInfo.outputPath("single-view-shape-metrics.json");
  writeFileSync(metricPath, JSON.stringify({ failed: failedProof, passed: passedProof }, null, 2));
  await testInfo.attach("single-view-shape-metrics.json", { path: metricPath, contentType: "application/json" });

  const fixedFixtures = await page.evaluate(async () => {
    interface BrowserMask {
      width: number;
      height: number;
      data: Uint8Array;
    }
    const modulePath = "/src/agent/shapeProof.ts";
    const shapeProof = await import(/* @vite-ignore */ modulePath) as unknown as {
      compareShapeMasks: (source: BrowserMask, rendered: BrowserMask, mmPerPixel: number) => Promise<object>;
      encodeShapeMask: (mask: BrowserMask) => EncodedMask;
    };
    const width = 64;
    const height = 64;
    const make = (predicate: (x: number, y: number) => boolean, foreground = 255): BrowserMask => {
      const data = new Uint8Array(width * height);
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          if (predicate(x, y)) data[y * width + x] = foreground;
        }
      }
      return { width, height, data };
    };
    const rectangle = (left = 16, top = 16, right = 47, bottom = 47, foreground = 255) =>
      make((x, y) => x >= left && x <= right && y >= top && y <= bottom, foreground);
    const source = rectangle();
    const candidates = {
      exact: rectangle(),
      translation: rectangle(20, 16, 51, 47),
      scaleError: rectangle(12, 12, 51, 51),
      missingGeometry: make(() => false),
      contourDistortion: make((x, y) => x >= 16 && x <= 47 && y >= 16 && y <= 47 && x + y >= 38),
      antiAliasedEdges: rectangle(16, 16, 47, 47, 180),
    };
    const cases: Record<string, { source: EncodedMask; render: EncodedMask; metrics: object }> = {};
    for (const [name, candidate] of Object.entries(candidates)) {
      cases[name] = {
        source: shapeProof.encodeShapeMask(source),
        render: shapeProof.encodeShapeMask(candidate),
        metrics: await shapeProof.compareShapeMasks(source, candidate, 0.1),
      };
    }
    return cases;
  });
  for (const [name, fixture] of Object.entries(fixedFixtures)) {
    await attachMask(testInfo, `fixture-${name}-source`, fixture.source);
    await attachMask(testInfo, `fixture-${name}-render`, fixture.render);
  }
  const fixtureMetricPath = testInfo.outputPath("fixed-mask-metrics.json");
  writeFileSync(fixtureMetricPath, JSON.stringify(fixedFixtures, null, 2));
  await testInfo.attach("fixed-mask-metrics.json", { path: fixtureMetricPath, contentType: "application/json" });
});
