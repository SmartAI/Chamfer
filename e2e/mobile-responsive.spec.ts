// Phone-viewport eval for the mobile responsive work (issue #54). Runs only in
// the mobile-chromium project (Pixel 5, a real touch device). It gates the
// invariants a shared-link first visit depends on: the layout collapses to the
// single-panel mobile shell, nothing scrolls the page sideways at phone widths,
// the panel toggle and history drawer work by tap, primary controls are
// thumb-sized, and Settings opens as a full-screen sheet.
//
// A full prompt-to-artifact turn is out of scope here: it needs a real model
// and the build123d MCP, which this hermetic stack does not run (see
// app-boot.spec.ts). This eval covers everything short of the turn itself.
import { expect, test } from "@playwright/test";
import { clearConversations, startBuild123dConversation } from "./helpers";

/** The page must never scroll horizontally; 1px of sub-pixel rounding is fine. */
async function horizontallyOverflows(page: import("@playwright/test").Page): Promise<boolean> {
  return page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  );
}

/** On mobile the "New chat" button lives in the slide-in drawer, so open it
 * first, then run the shared build123d creation flow. */
async function createBuild123dConversation(page: import("@playwright/test").Page): Promise<void> {
  await page.getByTestId("mobile-history").tap();
  await expect(page.getByTestId("sidebar")).toBeVisible();
  await startBuild123dConversation(page);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await clearConversations(page);
  await page.reload();
});

test("collapses to the mobile shell with no sideways scroll at phone widths", async ({ page }) => {
  // The single-panel shell shows its bottom nav; the desktop resize handles are gone.
  await expect(page.getByTestId("mobile-history")).toBeVisible();
  await expect(page.getByRole("separator", { name: "Resize sidebar" })).toHaveCount(0);
  expect(await horizontallyOverflows(page)).toBe(false);

  // A conversation adds the viewer and the Chat/3D toggle - still no overflow,
  // at the default width and at a narrow Android width.
  await createBuild123dConversation(page);
  await expect(page.getByTestId("chat-panel")).toBeVisible();
  expect(await horizontallyOverflows(page)).toBe(false);

  await page.setViewportSize({ width: 360, height: 800 });
  expect(await horizontallyOverflows(page)).toBe(false);
});

test("toggles between chat and 3D by tap, both panels staying mounted", async ({ page }) => {
  await createBuild123dConversation(page);
  await expect(page.getByTestId("chat-panel")).toBeVisible();
  await expect(page.getByTestId("right-panel")).toBeHidden();

  await page.getByTestId("mobile-tab-viewer").tap();
  await expect(page.getByTestId("right-panel")).toBeVisible();
  await expect(page.getByTestId("viewer")).toBeVisible();
  await expect(page.getByTestId("chat-panel")).toBeHidden();

  await page.getByTestId("mobile-tab-chat").tap();
  await expect(page.getByTestId("chat-panel")).toBeVisible();
  await expect(page.getByTestId("right-panel")).toBeHidden();
});

test("sizes the composer's primary controls for touch", async ({ page }) => {
  await createBuild123dConversation(page);
  for (const testId of ["composer-attach", "composer-send"]) {
    const box = await page.getByTestId(testId).boundingBox();
    expect(box, `${testId} should render`).not.toBeNull();
    // >= 44px is the touch-target floor; allow a sub-pixel hair under.
    expect(box!.height).toBeGreaterThanOrEqual(43.5);
  }
});

test("opens Settings as a full-screen sheet from the history drawer", async ({ page }) => {
  // The Settings control lives in the sidebar, which is the slide-in drawer on
  // mobile; open it, then open Settings.
  await page.getByTestId("mobile-history").tap();
  await page.getByTestId("sidebar").getByRole("button", { name: "Settings" }).tap();

  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();

  // A full-screen sheet spans essentially the whole viewport width, not a
  // centered card capped at max-w-lg (512px).
  const box = await dialog.boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(box!.width).toBeGreaterThanOrEqual(viewport!.width - 2);
});
