import { expect, test } from "@playwright/test";

test("conflicting source evidence asks one focused question and resumes from the user's answer", async ({ page }, testInfo) => {
  test.setTimeout(600_000);
  await page.goto("/");
  await page.getByTestId("sidebar").getByRole("button", { name: "New chat", exact: true }).first().click();
  await page.getByRole("dialog", { name: "Choose a CAD environment" })
    .getByRole("button", { name: "Start conversation" }).click();

  const composer = page.getByTestId("composer-input");
  await composer.fill("exception-escalation-flow: one note says the width is 10 mm, while another says the width is 12 mm");
  await page.getByTestId("composer-send").click();

  const escalation = page.getByTestId("design-escalation-card");
  await expect(escalation).toBeVisible({ timeout: 30_000 });
  await expect(escalation).toHaveAttribute("data-status", "pending");
  await expect(escalation).toContainText("Should the spacer be 10 mm or 12 mm wide?");

  const conversations = await (await page.request.get("/api/conversations")).json() as Array<{ id: string }>;
  const conversationId = conversations[0]!.id;
  await expect.poll(async () => {
    const artifacts = await (await page.request.get(`/api/conversations/${conversationId}/artifacts`)).json() as unknown[];
    return artifacts.length;
  }).toBe(0);

  await composer.fill("Use 12 mm wide.");
  await page.getByTestId("composer-send").click();

  await expect(escalation).toHaveAttribute("data-status", "resolved", { timeout: 30_000 });
  await expect(page.getByText("Resolved source evidence restored autonomous CAD eligibility.", { exact: false })).toBeVisible({ timeout: 600_000 });
  await page.getByTestId("source-specifications-toggle").click();
  const specifications = page.getByTestId("source-specification");
  await expect(specifications.filter({ has: page.getByText("width-10", { exact: true }) })).toContainText("superseded");
  await expect(specifications.filter({ has: page.getByText("width-12", { exact: true }) })).toContainText("superseded");
  await expect(specifications.filter({ has: page.getByText("width-resolved-12", { exact: true }) })).toContainText("Use 12 mm wide.");

  const persisted = await (await page.request.get(`/api/conversations/${conversationId}/messages`)).json() as Array<{ contentJson: string }>;
  const planResults = persisted
    .map((message) => JSON.parse(message.contentJson) as { role?: string; toolName?: string; isError?: boolean })
    .filter((message) => message.role === "toolResult" && message.toolName === "create_plan");
  expect(planResults.map((message) => message.isError)).toEqual([true, false]);
  const artifacts = await (await page.request.get(`/api/conversations/${conversationId}/artifacts`)).json() as unknown[];
  expect(artifacts).toHaveLength(1);
  const escalationHistory = await (await page.request.get(`/api/conversations/${conversationId}/design-escalations`)).json() as Array<{
    status: string;
    resolutionSpecificationIds: string[];
  }>;
  expect(escalationHistory).toEqual([expect.objectContaining({
    status: "resolved",
    resolutionSpecificationIds: ["width-resolved-12"],
  })]);
  const sourceHistory = await (await page.request.get(`/api/conversations/${conversationId}/source-specifications`)).json() as Array<{
    id: string;
    status: string;
  }>;
  expect(sourceHistory.map(({ id, status }) => ({ id, status }))).toEqual([
    { id: "width-10", status: "superseded" },
    { id: "width-12", status: "superseded" },
    { id: "width-resolved-12", status: "active" },
  ]);

  await page.screenshot({ path: testInfo.outputPath("exception-resolved.png"), fullPage: true });
});

test("documented conservative defaults proceed without routine confirmation", async ({ page }) => {
  test.setTimeout(600_000);
  await page.goto("/");
  await page.getByTestId("sidebar").getByRole("button", { name: "New chat", exact: true }).first().click();
  await page.getByRole("dialog", { name: "Choose a CAD environment" })
    .getByRole("button", { name: "Start conversation" }).click();

  const composer = page.getByTestId("composer-input");
  await composer.fill("proof-contract-flow: build a 30 x 20 x 4 mm mounting plate with four 4 mm through holes");
  await page.getByTestId("composer-send").click();

  await expect(page.getByText("Initial mounting plate complete", { exact: false })).toBeVisible({ timeout: 600_000 });
  await expect(page.getByTestId("design-escalation-card")).toHaveCount(0);
  await page.getByTestId("proof-contract-toggle").click();
  await expect(page.getByTestId("proof-contract-conservative-default")).toContainText("one connected, valid solid");
});
