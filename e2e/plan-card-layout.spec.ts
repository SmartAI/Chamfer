import { expect, test } from "@playwright/test";

test("a long expanded plan scrolls without displacing the conversation", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("sidebar").getByRole("button", { name: "New chat", exact: true }).first().click();
  await page.getByTestId("composer-input").fill("long-plan-layout: show a plan with many components");
  await page.getByTestId("composer-send").click();

  const toggle = page.getByTestId("plan-card-toggle");
  await expect(toggle).toBeVisible();
  await toggle.click();

  const contents = page.getByTestId("plan-card-contents");
  await expect(contents).toBeVisible();
  const layout = await contents.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    overflowY: getComputedStyle(element).overflowY,
  }));

  expect(layout.clientHeight).toBeLessThanOrEqual(Math.min(page.viewportSize()!.height * 0.4, 384) + 1);
  expect(layout.scrollHeight).toBeGreaterThan(layout.clientHeight);
  expect(layout.overflowY).toBe("auto");
  await expect(toggle).toBeVisible();
  await expect(page.getByTestId("message-list")).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileLayout = await contents.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(mobileLayout.clientHeight).toBeLessThanOrEqual(844 * 0.4 + 1);
  expect(mobileLayout.scrollHeight).toBeGreaterThan(mobileLayout.clientHeight);
  await expect(page.getByTestId("message-list")).toBeVisible();

  await contents.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect.poll(() => contents.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(contents).toBeHidden();
  await expect(page.getByTestId("message-list")).toBeVisible();
});
