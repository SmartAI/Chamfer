import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("binds a text-only single part to a downloadable current proof report", async ({ page }, testInfo) => {
  test.setTimeout(600_000);
  await page.goto("/");
  await page.getByTestId("sidebar").getByRole("button", { name: "New chat", exact: true }).first().click();
  await page.getByRole("dialog", { name: "Choose a CAD environment" })
    .getByRole("button", { name: "Start conversation" }).click();

  const composer = page.getByTestId("composer-input");
  await expect(composer).toBeEnabled();
  await composer.fill("proof-contract-flow: build a 30 x 20 x 4 mm mounting plate with four 4 mm through holes");
  await page.getByTestId("composer-send").click();

  await expect(page.getByText("Initial mounting plate complete", { exact: false })).toBeVisible({ timeout: 600_000 });
  const report = page.getByTestId("proof-report-card");
  await expect(report).toBeVisible({ timeout: 10_000 });
  await expect(report).toHaveAttribute("data-proof-report-status", "proven");
  await expect(report).toContainText("CAD artifact 1");
  await expect(report).toContainText("Shape proof Not applicable");
  await expect(report).toContainText("Visual verification Not applicable");
  await expect(page.getByTestId("proof-report-download")).toBeEnabled();

  const conversations = await (await page.request.get("/api/conversations")).json() as Array<{ id: string }>;
  const conversationId = conversations[0]!.id;
  const reports = await (await page.request.get(`/api/conversations/${conversationId}/proof-reports`)).json() as Array<{
    reportId: string;
    status: string;
    proofContract: { contractId: string; revision: number };
    acceptedPlan: { planId: string; criteriaRevision: number };
    sourceSpecifications: unknown[];
    cadArtifact: { id: string; version: number };
    engineering: { verificationGate: { verdict: string }; planConformance: { verdict: string } };
    bodyIntegrity: { state: string };
  }>;
  expect(reports).toHaveLength(1);
  expect(reports[0]).toMatchObject({
    status: "proven",
    acceptedPlan: { criteriaRevision: 1 },
    cadArtifact: { version: 1 },
    engineering: { verificationGate: { verdict: "passed" }, planConformance: { verdict: "passed" } },
    bodyIntegrity: { state: "proven" },
  });
  expect(reports[0]!.sourceSpecifications).toHaveLength(2);

  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("proof-report-download").click();
  const download = await downloadPromise;
  const jsonPath = testInfo.outputPath("proof-report.json");
  await download.saveAs(jsonPath);
  const downloaded = JSON.parse(await readFile(jsonPath, "utf8")) as typeof reports[number] & { pySource?: unknown };
  expect(downloaded.reportId).toBe(reports[0]!.reportId);
  expect(downloaded.pySource).toBeUndefined();
  await page.screenshot({ path: testInfo.outputPath("current-proof-report.png"), fullPage: true });

  const artifacts = await (await page.request.get(`/api/conversations/${conversationId}/artifacts`)).json() as Array<{
    pySource: string;
  }>;
  const revisedArtifact = await page.request.post(`/api/conversations/${conversationId}/artifacts`, {
    data: { pySource: artifacts[0]!.pySource, paramsJson: null },
  });
  expect(revisedArtifact.ok()).toBe(true);
  await page.reload();
  await expect(page.getByTestId("proof-report-card")).toHaveAttribute("data-proof-report-status", "stale", { timeout: 60_000 });
  await expect(page.getByTestId("proof-report-card")).toContainText("CAD artifact 1");
  await expect(page.getByTestId("viewer-booting")).toBeHidden({ timeout: 600_000 });
  await expect(page.getByTestId("viewer-rendering")).toBeHidden({ timeout: 600_000 });
  await page.screenshot({ path: testInfo.outputPath("stale-proof-report.png"), fullPage: true });
});
