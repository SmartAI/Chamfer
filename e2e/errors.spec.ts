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
  // already configured (leftover DB, fake mode's fallback model, or a .env.local that
  // seeds CHAMFER_MODEL) the disabled-composer assertions below would test the wrong
  // state. Skip rather than fail: the no-model scenario only exists in a clean
  // real-mode environment, and a batch run under CHAMFER_FAKE_LLM=1 can never
  // satisfy it, while CI with a clean env still exercises it.
  const settings = (await (await request.get("/api/settings")).json()) as { modelJson?: string };
  test.skip(
    Boolean(settings.modelJson),
    "settings already contain a model (fake mode or env-seeded); needs real mode with a fresh DB and no CHAMFER_MODEL env",
  );

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
