import { expect, test } from "@playwright/test";
import { clearConversations } from "./helpers";

test("production agent path creates one verified parametric Fusion solid with one native Undo entry", async ({ page }) => {
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

  const records = await (await page.request.get(`/api/conversations/${conversation.id}/fusion-actions`)).json() as Array<{ event: string; intent: string; result: Record<string, unknown> }>;
  expect(records.map((record) => record.event)).toEqual(["attempt", "completed"]);
  expect(records.at(-1)?.result).toMatchObject({ status: "completed", undoEntries: 1 });
  // The audit ledger is API-only now that the chat-only Fusion workspace shows
  // no action history; the privacy-safe hashed intent lives in the records.
  expect(records.at(-1)?.intent).toMatch(/^sha256:[a-f0-9]{64}$/);
  const trace = await (await page.request.get("http://127.0.0.1:8997/trace")).json() as { mutationCalls: number; nativeUndoEntries: number; hasSolid: boolean; unmatchedScripts?: string[] };
  expect(trace).toMatchObject({ mutationCalls: 1, nativeUndoEntries: 1, hasSolid: true, unmatchedScripts: [] });

  await expect(page.getByTestId("fusion-revision")).toBeVisible({ timeout: 30_000 });
});
