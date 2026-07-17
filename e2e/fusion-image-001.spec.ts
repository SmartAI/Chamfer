import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { FUS_IMAGE_001 } from "@chamfer/fusion-fixtures";
import { clearConversations } from "./helpers";

const REFERENCE = readFileSync(".scratch/fusion-connector/fixtures/FUS-IMAGE-001-reference.png");
const FUSION_FAKE = `http://127.0.0.1:${process.env.FUSION_FAKE_PORT ?? "8997"}`;

async function startFusionFixture(page: import("@playwright/test").Page): Promise<{ id: string }> {
  await page.goto("about:blank");
  await page.waitForTimeout(250);
  await clearConversations(page);
  await page.goto("/");
  const created = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/api/conversations"));
  await page.getByTestId("sidebar").getByRole("button", { name: "New chat", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "Choose a CAD environment" });
  await dialog.getByRole("radio", { name: /Autodesk Fusion/ }).check();
  await dialog.getByRole("button", { name: "Start conversation" }).click();
  return await (await created).json() as { id: string };
}

async function submitFixture(page: import("@playwright/test").Page): Promise<void> {
  await page.getByTestId("composer-input").fill(FUS_IMAGE_001.prompt);
  await page.getByTestId("composer-file-input").setInputFiles({ name: FUS_IMAGE_001.reference.fileName, mimeType: "image/png", buffer: REFERENCE });
  await page.getByTestId("composer-send").click();
}

test("FUS-IMAGE-001 completes through attachment, planning, Fusion inspection, and visual finalization", async ({ page }) => {
  await page.request.post(`${FUSION_FAKE}/control/ready`);
  await page.request.post(`${FUSION_FAKE}/trace/reset`);
  const conversation = await startFusionFixture(page);
  await submitFixture(page);
  // The deterministic plan stop-gate can nudge the agent once after completion,
  // making the scripted fake restate the same completion text; assert presence,
  // not uniqueness.
  await expect(page.getByText(/FUS-IMAGE-001 is complete on one visually verified Fusion revision/).first()).toBeVisible({ timeout: 180_000 });

  const messages = await (await page.request.get(`/api/conversations/${conversation.id}/messages`)).json() as Array<{ id: string; role: string }>;
  const userMessage = messages.find((message) => message.role === "user")!;
  const attachments = await (await page.request.get(`/api/messages/${userMessage.id}/attachments`)).json() as Array<{ contentHash: string }>;
  expect(attachments[0]?.contentHash).toBe(FUS_IMAGE_001.reference.sha256);

  const references = await (await page.request.get(`/api/conversations/${conversation.id}/references`)).json() as Array<{
    status: string; purpose: string; specificationLinks: string[];
  }>;
  expect(references).toEqual([expect.objectContaining({ status: "active", purpose: expect.stringMatching(/front, top, and right-side/),
    specificationLinks: expect.arrayContaining(["plan.spec_sheet.front-width", "plan.spec_sheet.upright-holes", "plan.spec_sheet.appearance"]) })]);

  const records = await (await page.request.get(`/api/conversations/${conversation.id}/fusion-actions`)).json() as Array<{
    event: string; expectedEffects: unknown[]; result: { checks?: Array<{ status: string }> };
  }>;
  expect(records.map((record) => record.event)).toEqual(["attempt", "completed"]);
  expect(records.at(-1)?.expectedEffects).toHaveLength(FUS_IMAGE_001.expectedEffects.length);
  expect(records.at(-1)?.expectedEffects.map((effect) => (effect as { kind: string }).kind))
    .toEqual(FUS_IMAGE_001.expectedEffects.map((effect) => effect.kind));
  expect(records.at(-1)?.result.checks?.every((check) => check.status === "passed")).toBe(true);

  const inspection = await (await page.request.post(`/api/conversations/${conversation.id}/fusion-inspections`, { data: { checks: [] } })).json() as {
    current: { snapshot: { entities: Array<{ kind: string; semanticDescriptor?: string }> } };
  };
  const identities = inspection.current.snapshot.entities;
  expect(identities.filter((entity) => entity.kind === "parameter").length).toBeGreaterThanOrEqual(16);
  expect(identities.filter((entity) => entity.kind === "sketch").length).toBeGreaterThanOrEqual(6);
  expect(identities.filter((entity) => entity.kind === "feature").length).toBeGreaterThanOrEqual(8);
  expect(identities).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: "body", semanticDescriptor: "body:FUS-IMAGE-001 Orange ABS Bracket" }),
  ]));

  const verifications = await (await page.request.get(`/api/conversations/${conversation.id}/visual-verifications`)).json() as Array<{ verdict: string }>;
  expect(verifications).toEqual([expect.objectContaining({ verdict: "match" })]);
  const trace = await (await page.request.get(`${FUSION_FAKE}/trace`)).json() as Record<string, unknown>;
  expect(trace).toMatchObject({ mutationCalls: 1, nativeUndoEntries: 1, hasSolid: true, model: "bracket" });
});

test("FUS-IMAGE-001 rejects reversed, wrong-face, swapped, omitted, and stale-or-unsupported evidence outcomes", async ({ page }) => {
  for (const variant of ["reversed-upright", "wrong-face-holes", "swapped-diameters", "omitted-feature", "wrong-feature-size", "wrong-material", "wrong-appearance", "wrong-dimensions", "displaced-camera", "wrong-document", "unsupported-verification"] as const) {
    await page.request.post(`${FUSION_FAKE}/control/ready`);
    await page.request.post(`${FUSION_FAKE}/trace/reset`);
    await page.request.post(`${FUSION_FAKE}/fixture/${variant}`);
    await startFusionFixture(page);
    await submitFixture(page);
    const rejected = page.getByText(/FUS-IMAGE-001 did not complete/).last();
    const completed = page.getByText(/FUS-IMAGE-001 is complete on one visually verified Fusion revision/);
    await expect(rejected.or(completed)).toBeVisible({ timeout: 180_000 });
    expect(await completed.count(), `${variant} must not reach completion`).toBe(0);
  }
});

test("FUS-IMAGE-001 rejects a completed sheet after a newer retained Fusion revision", async ({ page }) => {
  await page.request.post(`${FUSION_FAKE}/control/ready`);
  await page.request.post(`${FUSION_FAKE}/trace/reset`);
  // The variants test above leaves the fake in its last fixture mode; reset it
  // so this test is order-independent within the file.
  await page.request.post(`${FUSION_FAKE}/fixture/passing`);
  const conversation = await startFusionFixture(page);
  let injected = false;
  await page.route("**/api/conversations/*/visual-verification-batches", async (route) => {
    if (!injected && route.request().method() === "POST") {
      injected = true;
      const response = await page.request.post(`/api/conversations/${conversation.id}/messages`, { data: {
        id: "e2e-newer-nonconforming-revision", seq: 10_000, role: "toolResult",
        contentJson: JSON.stringify({ role: "toolResult", toolName: "run_fusion_action", isError: false,
          details: { status: "nonconforming", finalRevision: "manual-newer-revision" } }),
      } });
      expect(response.ok()).toBe(true);
    }
    await route.continue();
  });
  await submitFixture(page);

  // The deterministic plan stop-gate nudges the agent once before accepting a
  // stop with unfinished plan work, so the scripted fake restates its
  // assessment; assert presence, not uniqueness.
  await expect(page.getByText(/current Fusion revision invalidated the earlier inspection sheet/).first()).toBeVisible({ timeout: 180_000 });
  await expect(page.getByText(/FUS-IMAGE-001 is complete on one visually verified Fusion revision/)).toHaveCount(0);
  expect(injected).toBe(true);
});
