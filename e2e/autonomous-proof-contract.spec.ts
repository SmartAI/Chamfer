import { expect, test } from "@playwright/test";
import { startBuild123dConversation } from "./helpers";

test("text-only single-part work freezes and revises an inspectable proof contract autonomously", async ({ page }, testInfo) => {
  test.setTimeout(600_000);
  await page.goto("/");
  await startBuild123dConversation(page);

  const composer = page.getByTestId("composer-input");
  await expect(composer).toBeEnabled();
  await composer.fill("proof-contract-flow: build a 30 x 20 x 4 mm mounting plate with four 4 mm through holes");
  await page.getByTestId("composer-send").click();

  const contract = page.getByTestId("proof-contract-card");
  await expect(contract).toBeVisible({ timeout: 30_000 });
  await expect(contract).toHaveAttribute("data-contract-status", "current");
  await expect(contract).toHaveAttribute("data-shape-proof-status", "not-applicable");
  await expect(page.getByTestId("proof-contract-revision")).toHaveText("Revision 1");
  await page.getByTestId("proof-contract-toggle").click();
  await expect(page.getByTestId("proof-contract-explicit-requirement")).toContainText("30 x 20 x 4 mm");
  await expect(page.getByTestId("proof-contract-source-derived-requirement")).toContainText("None");
  await expect(page.getByTestId("proof-contract-conservative-default")).toContainText("one connected, valid solid");
  await expect(page.getByTestId("proof-contract-agent-assumption")).toContainText("rectangular mounting plate");
  await expect(page.getByTestId("proof-contract-planned-checks")).toContainText("plate.holes: hole_through");
  await expect(page.getByTestId("proof-contract-unavailable-evidence")).toContainText("None");
  await expect(page.getByTestId("proof-contract-shape-proof")).toContainText("not applicable");

  await expect(page.getByText("Initial mounting plate complete", { exact: false })).toBeVisible({ timeout: 600_000 });
  const conversations = await (await page.request.get("/api/conversations")).json() as Array<{ id: string }>;
  const conversationId = conversations[0]!.id;
  const initialContracts = await (await page.request.get(`/api/conversations/${conversationId}/proof-contracts`)).json() as Array<{
    contractId: string;
    revision: number;
    status: string;
    derivation: { planId: string; criteriaRevision: number; shapeProof: { status: string } };
  }>;
  expect(initialContracts).toHaveLength(1);
  expect(initialContracts[0]).toMatchObject({
    revision: 1,
    status: "current",
    derivation: { criteriaRevision: 1, shapeProof: { status: "not-applicable" } },
  });

  const messages = await (await page.request.get(`/api/conversations/${conversationId}/messages`)).json() as Array<{ seq: number; contentJson: string }>;
  const parsed = messages.map((message) => ({ seq: message.seq, value: JSON.parse(message.contentJson) as {
    role?: string;
    toolName?: string;
    isError?: boolean;
    details?: { measurements?: { component?: string | string[] } };
  } }));
  const successfulRuns = parsed.filter(({ value }) => value.role === "toolResult" && value.toolName === "run_build123d" && !value.isError);
  expect(successfulRuns.map(({ value }) => value.details?.measurements?.component)).toEqual(["probe", "plate"]);
  const artifacts = await (await page.request.get(`/api/conversations/${conversationId}/artifacts`)).json() as unknown[];
  expect(artifacts).toHaveLength(1);

  await composer.fill("proof-contract-revise: tighten the planned volume evidence without changing the explicit part requirements");
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("proof-contract-revision")).toHaveText("Revision 2", { timeout: 600_000 });
  await expect(page.getByText("Revised proof contract and mounting plate are current.", { exact: false }).first()).toBeVisible({ timeout: 600_000 });
  const revisedContracts = await (await page.request.get(`/api/conversations/${conversationId}/proof-contracts`)).json() as Array<{
    contractId: string;
    revision: number;
    status: string;
    proofStatus: string;
    derivation: { criteriaRevision: number; invalidatedEvidenceIds: string[] };
  }>;
  expect(revisedContracts.map((item) => ({
    contractId: item.contractId,
    revision: item.revision,
    status: item.status,
    proofStatus: item.proofStatus,
    criteriaRevision: item.derivation.criteriaRevision,
  }))).toEqual([
    { contractId: revisedContracts[0]!.contractId, revision: 1, status: "stale", proofStatus: "stale", criteriaRevision: 1 },
    { contractId: revisedContracts[0]!.contractId, revision: 2, status: "current", proofStatus: "pending", criteriaRevision: 2 },
  ]);
  expect(revisedContracts[1]!.derivation.invalidatedEvidenceIds).toHaveLength(1);

  await page.reload();
  await expect(page.getByTestId("proof-contract-card")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("proof-contract-revision")).toHaveText("Revision 2");
  await expect(page.getByTestId("viewer-booting")).toBeHidden({ timeout: 600_000 });
  await expect(page.getByTestId("viewer-rendering")).toBeHidden({ timeout: 600_000 });
  await page.getByTestId("proof-contract-toggle").click();
  await expect(page.getByTestId("proof-contract-agent-assumption")).toContainText("rectangular mounting plate");
  await page.screenshot({ path: testInfo.outputPath("proof-contract-reload.png"), fullPage: true });
});
