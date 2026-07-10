import { expect, test } from "@playwright/test";

// Runs in REAL mode (no CHAMFER_FAKE_LLM) against a fresh empty DB: delete
// data/chamfer.db before the run so settings hold no model and no API keys.
//
// Observed behavior in that state: GET /api/settings returns no modelJson (there is
// no model fallback outside fake mode), so no session is created and the composer is
// disabled with a hint pointing at Settings. A message cannot be sent at all, which
// is the graceful-degradation contract this test pins down; the app must stay usable
// by still letting the user open the settings modal to add a key.
test("with no API key configured the composer is disabled with a settings hint and the app stays usable", async ({
  page,
  request,
}) => {
  // Enforce the fresh-DB precondition instead of trusting the runner: with a model
  // already configured (leftover DB or fake mode) the disabled-composer assertions
  // below would be testing the wrong state.
  const settings = (await (await request.get("/api/settings")).json()) as { modelJson?: string };
  expect(
    settings.modelJson,
    "Precondition failed: settings already contain a model. Run in real mode (no CHAMFER_FAKE_LLM) and delete data/chamfer.db first.",
  ).toBeFalsy();

  await page.goto("/");
  await page.getByTestId("sidebar").getByRole("button", { name: "New chat", exact: true }).click();

  await expect(page.getByTestId("composer-input")).toBeDisabled();
  await expect(page.getByTestId("composer-send")).toBeDisabled();
  await expect(
    page.getByText("Configure a model and API key in Settings to start chatting."),
  ).toBeVisible();

  // App stays usable: the settings modal opens, ready for a key to be added.
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Settings")).toBeVisible();
  await expect(dialog.getByLabel("API key")).toBeVisible();
});
