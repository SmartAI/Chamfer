import { expect, test } from "@playwright/test";

// CAD code bodies are hidden in chat by default (CHAMFER_SHOW_CAD_CODE unset in
// the e2e stack). The enabled state is exercised through the settings DB
// override (PUT /api/settings), which outranks env per the documented
// precedence - this avoids restarting the shared dev server with a different
// environment. The override is removed at the end so later specs in the serial
// battery see the default again.

const FAKE_CODE_MARKER = "from build123d import";

test("CAD code is hidden by default and shown when the setting is enabled", async ({ page, request }) => {
  test.setTimeout(600_000);

  await page.goto("/");
  await page.getByTestId("sidebar").getByRole("button", { name: "New chat", exact: true }).first().click();
  const composer = page.getByTestId("composer-input");
  await expect(composer).toBeEnabled();
  await composer.fill("make a box 10 by 20 by 30");
  await page.getByTestId("composer-send").click();

  const card = page.getByTestId("tool-call-card");
  await expect(card).toBeVisible({ timeout: 600_000 });
  await expect(card).toContainText("run_build123d");
  await expect(page.getByTestId("tool-gate")).toHaveAttribute("data-status", "passed", { timeout: 600_000 });

  // Hidden default: the placeholder row with its actions is there, the body is not.
  await expect(card).toContainText("CAD code");
  await expect(card.getByRole("button", { name: "Copy code" })).toBeVisible();
  await expect(card.getByTestId("render-code")).toBeVisible();
  await expect(card).not.toContainText(FAKE_CODE_MARKER);
  await expect(page.getByTestId("cad-code")).toHaveCount(0);

  // Enable via the settings override (db > env) and reload: bodies render.
  const put = await request.put("/api/settings", { data: { showCadCode: "1" } });
  expect(put.ok()).toBeTruthy();
  try {
    await page.reload();
    await expect(page.getByTestId("tool-call-card")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("cad-code")).toContainText(FAKE_CODE_MARKER);
  } finally {
    const reset = await request.put("/api/settings", { data: { showCadCode: null } });
    expect(reset.ok()).toBeTruthy();
  }
});
