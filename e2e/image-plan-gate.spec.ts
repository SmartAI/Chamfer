import { expect, test } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { startBuild123dConversation } from "./helpers";

test("image design rejects CAD and legacy snapshots before rendering normalized source coverage", async ({ page }, testInfo) => {
  test.setTimeout(600_000);
  await page.goto("/");
  await startBuild123dConversation(page);
  const composer = page.getByTestId("composer-input");
  await expect(composer).toBeEnabled();
  await composer.fill("image-plan-gate: build the dimensioned spacer in this drawing");
  await page.getByTestId("composer-file-input").setInputFiles({
    name: "spacer.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ),
  });
  await page.getByTestId("composer-send").click();

  const rejectedRun = page
    .getByRole("button", { name: "Executing code Failed", exact: true })
    .locator("..");
  await expect(rejectedRun).toContainText("create_plan", { timeout: 600_000 });
  await expect(rejectedRun).toContainText("stable identities");

  const rejectedPlanButton = page.getByRole("button", { name: "Updated plan Failed", exact: true });
  await rejectedPlanButton.click();
  await expect(rejectedPlanButton.locator("..")).toContainText("update_plan is retired", {
    timeout: 60_000,
  });
  await expect(rejectedPlanButton.locator("..")).toContainText("create_plan");

  const planCard = page.getByTestId("plan-card");
  await expect(planCard).toBeVisible({ timeout: 600_000 });
  await expect(planCard).toHaveAttribute("data-plan-format", "domain-operations-v1");
  await expect(page.getByTestId("plan-progress")).toHaveText("1/1 components", { timeout: 600_000 });
  await expect(page.getByTestId("plan-source-coverage")).toHaveText("2/2 source requirements current");
  await page.getByTestId("source-specifications-toggle").click();
  await page.getByTestId("plan-card-toggle").click();
  await expect(page.getByTestId("plan-history-entry")).toHaveCount(2);
  await expect(page.getByTestId("source-specification")).toHaveCount(2);

  const completedRun = page.getByTestId("tool-call-card").filter({ has: page.getByTestId("tool-gate") });
  await expect(completedRun.getByTestId("tool-gate")).toHaveAttribute("data-status", "passed", { timeout: 600_000 });
  await expect(page.getByText(/Dominant-form review: the spacer is prismatic/)).toBeVisible();
  await expect(page.getByTestId("visual-verify-chip")).toHaveAttribute("data-verdict", "match", { timeout: 600_000 });
  await expect(page.getByTestId("error-banner")).toHaveCount(0);
  const conversations = await (await page.request.get("/api/conversations")).json() as Array<{ id: string }>;
  const modelCapture = await (
    await page.request.get(`/api/test/fake-model-requests?conversationId=${conversations[0]!.id}`)
  ).json() as { requests: Array<{ authoritativePlanProjectionCount: number; sourceSpecificationProjectionCount: number; domainPlanPayloadCount: number }> };
  const authoritativeRequests = modelCapture.requests.filter((request) => request.authoritativePlanProjectionCount > 0);
  expect(authoritativeRequests.every((request) =>
    request.authoritativePlanProjectionCount === 1 &&
    request.sourceSpecificationProjectionCount === 1 &&
    request.domainPlanPayloadCount === 1
  )).toBe(true);
  await testInfo.attach("image-model-authority-context-counts.json", {
    body: JSON.stringify(modelCapture, null, 2),
    contentType: "application/json",
  });
  writeFileSync(testInfo.outputPath("image-model-authority-context-counts.json"), JSON.stringify(modelCapture, null, 2));
  await page.screenshot({ path: testInfo.outputPath("image-authoritative-plan.png"), fullPage: true });
});
