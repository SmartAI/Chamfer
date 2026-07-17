import { expect, test } from "@playwright/test";
import { FUS_TEXT_002 } from "@chamfer/fusion-fixtures";
import { clearConversations } from "./helpers";

const fakeFusionBase = `http://127.0.0.1:${process.env.FUSION_FAKE_PORT ?? "8997"}`;

async function startFusionFixture(page: import("@playwright/test").Page, clear = true): Promise<{ id: string }> {
  await page.goto("about:blank");
  // Let any in-flight readiness poll from the previous workspace finish before
  // deleting its conversation and ownership records.
  await page.waitForTimeout(500);
  await expect.poll(async () => (await page.request.get("/api/conversations")).status(), { timeout: 30_000 }).toBe(200);
  if (clear) await clearConversations(page);
  await page.goto("/");
  const created = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/api/conversations"));
  await page.getByTestId("sidebar").getByRole("button", { name: "New chat", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "Choose a CAD environment" });
  await dialog.getByRole("radio", { name: /Autodesk Fusion/ }).check();
  await dialog.getByRole("button", { name: "Start conversation" }).click();
  return await (await created).json() as { id: string };
}

test("FUS-TEXT-002 completes the industrial fixture through the production agent", async ({ page }) => {
  await page.request.post(`${fakeFusionBase}/control/ready`);
  await page.request.post(`${fakeFusionBase}/trace/reset`);
  const conversation = await startFusionFixture(page);

  await page.getByTestId("composer-input").fill(FUS_TEXT_002.prompt);
  await page.getByTestId("composer-send").click();
  // The deterministic plan stop-gate can nudge the scripted fake into restating
  // its final text; assert presence, not uniqueness.
  await expect(page.getByText(/FUS-TEXT-002 is complete on one inspected Fusion revision/).first()).toBeVisible({ timeout: 90_000 });

  const records = await (await page.request.get(`/api/conversations/${conversation.id}/fusion-actions`)).json() as Array<{
    event: string; expectedEffects: unknown[]; result: { checks?: Array<{ status: string }> };
  }>;
  expect(records.map((record) => record.event)).toEqual(["attempt", "completed"]);
  expect((records.at(-1)?.expectedEffects as Array<{ kind: string }>).map((effect) => effect.kind))
    .toEqual(FUS_TEXT_002.expectedEffects.map((effect) => effect.kind));
  expect(records.at(-1)?.result.checks?.every((check) => check.status === "passed")).toBe(true);

  expect(records.at(-1)?.result).toMatchObject({ status: "completed", undoEntries: 1 });

  const trace = await (await page.request.get(`${fakeFusionBase}/trace`)).json() as Record<string, unknown>;
  expect(trace).toMatchObject({ mutationCalls: 1, nativeUndoEntries: 1, hasSolid: true, model: "bearing-housing" });
});

test("FUS-TEXT-002 rejects broken industrial intent", async ({ page }) => {
  for (const variant of ["broken-datums", "mirrored-recess", "reversed-counterbores", "disconnected-gusset", "false-thread", "wrong-seat-fit"] as const) {
    await page.request.post(`${fakeFusionBase}/control/ready`);
    await page.request.post(`${fakeFusionBase}/trace/reset`);
    await page.request.post(`${fakeFusionBase}/fixture/${variant}`);
    const conversation = await startFusionFixture(page);
    await page.getByTestId("composer-input").fill(FUS_TEXT_002.prompt);
    await page.getByTestId("composer-send").click();
    await expect(page.getByText(/FUS-TEXT-002 did not complete/).first()).toBeVisible({ timeout: 90_000 });
    const records = await (await page.request.get(`/api/conversations/${conversation.id}/fusion-actions`)).json() as Array<{ result: { checks?: Array<{ status: string }> } }>;
    expect(records.flatMap((record) => record.result.checks ?? []).some((check) => check.status !== "passed"), variant).toBe(true);
  }
});
