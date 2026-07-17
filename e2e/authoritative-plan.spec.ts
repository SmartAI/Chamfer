import { expect, test } from "@playwright/test";
import { startBuild123dConversation } from "./helpers";
import { writeFileSync } from "node:fs";

test("corrected source evidence makes the plan stale until criteria and coverage are reconciled", async ({ page }, testInfo) => {
  test.setTimeout(600_000);
  await page.goto("/");
  await startBuild123dConversation(page);

  const composer = page.getByTestId("composer-input");
  await composer.fill(
    "authoritative-plan: Build a 10 mm wide, deep, and high spacer. Correction note: the authoritative width may become 12 mm wide.",
  );
  await page.getByTestId("composer-send").click();
  await expect(page.getByText("Initial authoritative plan is ready", { exact: false }).first()).toBeVisible({ timeout: 120_000 });

  const conversations = await (await page.request.get("/api/conversations")).json() as Array<{ id: string }>;
  const conversationId = conversations[0]!.id;
  const messages = await (await page.request.get(`/api/conversations/${conversationId}/messages`)).json() as Array<{
    id: string;
    contentJson: string;
  }>;
  const sourceMessage = messages.find((message) => JSON.parse(message.contentJson).role === "user")!;
  const sourceText = "the authoritative width may become 12 mm wide";
  const fullText = JSON.parse(sourceMessage.contentJson).content[0].text as string;
  const start = fullText.indexOf(sourceText);
  const correction = await page.request.post(`/api/conversations/${conversationId}/source-specifications`, {
    headers: { "Idempotency-Key": "authoritative-source-v2" },
    data: {
      specifications: [{
        id: "width-v2",
        requirement: "The corrected spacer width is 12 mm.",
        supersedesSpecificationId: "width-v1",
        source: { messageId: sourceMessage.id, text: sourceText, start, end: start + sourceText.length },
      }],
    },
  });
  expect(correction.ok()).toBe(true);

  await page.reload();
  await composer.fill("authoritative-plan: apply the corrected source evidence and continue");
  await page.getByTestId("composer-send").click();

  const staleRun = page.getByTestId("tool-call-card").filter({ hasText: "plan source coverage is stale" }).first();
  await expect(staleRun).toContainText("plan source coverage is stale", { timeout: 120_000 });
  await expect(staleRun).toContainText("width-v2");
  await expect(page.getByTestId("plan-source-coverage")).toHaveText("1/1 source requirements current", { timeout: 120_000 });
  await expect(page.getByTestId("plan-progress")).toHaveText("1/1 components", { timeout: 120_000 });
  await expect(page.getByTestId("plan-revision")).toHaveText("Revision 3 · criteria 2");

  const currentRun = page.getByRole("button", { name: "Executing code Complete", exact: true }).locator("..");
  await expect(currentRun.getByTestId("tool-gate")).toHaveAttribute("data-status", "passed", { timeout: 600_000 });
  const finalMessages = await (await page.request.get(`/api/conversations/${conversationId}/messages`)).json() as Array<{
    contentJson: string;
  }>;
  const currentEvidence = finalMessages.map((message) => JSON.parse(message.contentJson) as {
    toolCallId?: string;
    details?: { planConformance?: unknown };
  }).find((message) => message.toolCallId === "authoritative-current-run");
  expect(currentEvidence?.details?.planConformance).toEqual({
    status: "passed",
    planId: expect.any(String),
    componentCriteriaRevisions: { spacer: 2 },
  });
  await page.getByTestId("plan-card-toggle").click();
  await expect(page.getByTestId("plan-history-entry")).toHaveCount(3);
  const modelCapture = await (
    await page.request.get(`/api/test/fake-model-requests?conversationId=${conversationId}`)
  ).json() as { requests: Array<{
    sequence: number;
    authoritativePlanProjectionCount: number;
    sourceSpecificationProjectionCount: number;
    domainPlanPayloadCount: number;
  }> };
  const authoritativeRequests = modelCapture.requests.filter((request) => request.authoritativePlanProjectionCount > 0);
  expect(authoritativeRequests.length).toBeGreaterThan(0);
  expect(authoritativeRequests.every((request) =>
    request.authoritativePlanProjectionCount === 1 &&
    request.sourceSpecificationProjectionCount === 1 &&
    request.domainPlanPayloadCount === 1
  )).toBe(true);
  await testInfo.attach("model-authority-context-counts.json", {
    body: JSON.stringify(modelCapture, null, 2),
    contentType: "application/json",
  });
  writeFileSync(testInfo.outputPath("model-authority-context-counts.json"), JSON.stringify(modelCapture, null, 2));
  await page.screenshot({ path: testInfo.outputPath("authoritative-plan-recovered.png"), fullPage: true });
});
