import { expect, test } from "@playwright/test";
import { clearConversations } from "./helpers";

test("manual parameter edits reconcile automatically before a targeted intent-preserving follow-up", async ({ page }) => {
  await page.request.post("http://127.0.0.1:8997/control/ready");
  await page.request.post("http://127.0.0.1:8997/trace/reset");
  await page.goto("/");
  await clearConversations(page);
  await page.reload();
  const created = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/api/conversations"));
  await page.getByTestId("sidebar").getByRole("button", { name: "New chat", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "Choose a CAD environment" });
  await dialog.getByRole("radio", { name: /Autodesk Fusion/ }).check();
  await dialog.getByRole("button", { name: "Start conversation" }).click();
  const conversation = await (await created).json() as { id: string };

  await page.getByTestId("composer-input").fill("fusion-atomic-action: Create one editable 20 mm parametric cube.");
  await page.getByTestId("composer-send").click();
  // The deterministic plan stop-gate can nudge the scripted fake into restating
  // its final text; assert presence, not uniqueness.
  await expect(page.getByText(/available as exactly one native Undo step/).first()).toBeVisible({ timeout: 90_000 });

  const priorInspectionCount = await page.getByText("Inspect fusion", { exact: true }).count();
  await page.getByTestId("composer-input").fill("fusion-manual-reconciliation: Target width at 35 mm while preserving everything else, even if I edit Fusion during the work.");
  await page.getByTestId("composer-send").click();
  await expect(page.getByText("Inspect fusion", { exact: true })).toHaveCount(priorInspectionCount + 1, { timeout: 30_000 });
  await page.request.post("http://127.0.0.1:8997/manual/width/30");
  // The workspace reconciliation card is intentionally transient once the
  // targeted follow-up produces newer trusted evidence. The durable chat marker
  // proves stale work was canceled and the refreshed revision was consumed.
  await expect(page.locator("main")).toContainText("Fusion changed: stale work cancelled and refreshed evidence loaded", { timeout: 30_000 });
  await expect(page.getByText(/unaffected feature history, names, material, appearance, and manual intent were preserved/).first()).toBeVisible({ timeout: 90_000 });

  const records = await (await page.request.get(`/api/conversations/${conversation.id}/fusion-actions`)).json() as Array<{ event: string; result: Record<string, unknown> }>;
  expect(records.filter((record) => record.event === "completed")).toHaveLength(2);
  const trace = await (await page.request.get("http://127.0.0.1:8997/trace")).json() as { nativeUndoEntries: number; hasSolid: boolean };
  expect(trace).toMatchObject({ nativeUndoEntries: 1, hasSolid: true });

  const inspection = await (await page.request.post(`/api/conversations/${conversation.id}/fusion-inspections`, {
    data: { checks: [{ kind: "dimensions", expectedMm: [35, 20, 20], toleranceMm: 0.01 }, { kind: "material", expected: "Aluminum 6061" }] },
  })).json() as { current: { snapshot: { features: Array<{ name: string }>; bodies: Array<{ name: string; material?: string; appearance?: string }> }; checks: Array<{ status: string }> } };
  expect(inspection.current.snapshot.features).toEqual([expect.objectContaining({ name: "Cube extrusion" })]);
  expect(inspection.current.snapshot.bodies).toEqual([expect.objectContaining({ name: "Cube", material: "Aluminum 6061", appearance: "Blue anodized" })]);
  expect(inspection.current.checks.every((check) => check.status === "passed")).toBe(true);

  const workspace = page.getByTestId("fusion-document-strip");
  const revisionBeforeIdleEdit = await workspace.getByText(/^Revision /).textContent();
  const actionCountBeforeIdleEdit = records.length;
  await page.request.post("http://127.0.0.1:8997/manual/width/40");
  await expect.poll(() => workspace.getByText(/^Revision /).textContent(), { timeout: 30_000 })
    .not.toBe(revisionBeforeIdleEdit);
  await page.waitForTimeout(2_000);
  const recordsAfterIdleEdit = await (await page.request.get(`/api/conversations/${conversation.id}/fusion-actions`)).json() as unknown[];
  expect(recordsAfterIdleEdit).toHaveLength(actionCountBeforeIdleEdit);
});
