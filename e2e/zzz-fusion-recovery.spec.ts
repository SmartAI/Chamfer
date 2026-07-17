import { expect, test, type Page } from "@playwright/test";
import { FUS_TEXT_001_ACTION_BODY } from "@chamfer/fusion-fixtures";
import { clearConversations } from "./helpers";

const fakeFusion = "http://127.0.0.1:8997";

async function startAction(page: Page, outcome: string): Promise<{ id: string }> {
  await expect.poll(async () => (await page.request.get("/api/health")).ok()).toBe(true);
  await page.request.post(`${fakeFusion}/control/ready`);
  await page.request.post(`${fakeFusion}/trace/reset`);
  await page.request.post(`${fakeFusion}/action-outcome/${outcome}`);
  await page.goto("/");
  await clearConversations(page);
  await page.reload();
  const created = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/api/conversations"));
  await page.getByTestId("sidebar").getByRole("button", { name: "New chat", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "Choose a CAD environment" });
  await dialog.getByRole("radio", { name: /Autodesk Fusion/ }).check();
  await dialog.getByRole("button", { name: "Start conversation" }).click();
  const conversation = await (await created).json() as { id: string };
  await page.getByTestId("composer-input").fill("fusion-atomic-action: Create one editable 20 mm parametric cube.");
  await page.getByTestId("composer-send").click();
  return conversation;
}

async function terminalRecords(page: Page, conversationId: string) {
  const response = await page.request.get(`/api/conversations/${conversationId}/fusion-actions`);
  return await response.json() as Array<{ event: string; result: { reason?: string; status?: string } }>;
}

function boundedAction(actionId: string, expectedEvidenceId = "inspection-placeholder", expectedRevision = "revision-placeholder") {
  return {
    actionId,
    document: { id: "fake-document-1", name: "Readiness Fixture", dataFileId: "fake-data-file-1" },
    expectedEvidenceId,
    expectedRevision,
    intent: "Create one bounded parametric part",
    strategy: "targeted",
    body: FUS_TEXT_001_ACTION_BODY,
    affectedReferences: [],
    expectedEffects: [{ kind: "body-count", expected: 1 }],
    model: { provider: "anthropic", model: "chamfer-fake" },
    skills: { foundation: { name: "fusion-foundation", version: "1.0.0" }, loaded: [] },
  };
}

async function expectLifecycleBlocked(page: Page, conversationId: string, actionId: string) {
  const action = await page.request.post(`/api/conversations/${conversationId}/fusion-actions`, { data: boundedAction(actionId) });
  expect(action.status()).toBe(409);
  expect((await action.json() as { error: string }).error).toMatch(/lease|recovery/i);
  const save = await page.request.post(`/api/conversations/${conversationId}/fusion-save`, {
    data: { document: { id: "fake-document-1", name: "Readiness Fixture", dataFileId: "fake-data-file-1" } },
  });
  expect(save.status()).toBe(409);
  expect((await save.json() as { error: string }).error).toMatch(/lease|recovery/i);
  const transfer = await page.request.post(`/api/conversations/${conversationId}/fusion-ownership`);
  expect(transfer.status()).toBe(409);
  expect((await transfer.json() as { error: string }).error).toMatch(/lease|recovery/i);
}

test.describe.serial("Fusion interruption recovery through the production path", () => {
  for (const outcome of ["timeout", "disconnect"] as const) {
    test(`${outcome} reconnects only for diagnosis and proves the preceding revision unchanged`, async ({ page }) => {
      const conversation = await startAction(page, outcome);
      await expect.poll(async () => (await terminalRecords(page, conversation.id)).at(-1)?.event, { timeout: 90_000 }).toBe("failed");
      const records = await terminalRecords(page, conversation.id);
      expect(records.at(-1)?.result.reason).toBe(`${outcome}-no-change`);
      expect(await (await page.request.get(`/api/fusion/readiness?conversationId=${conversation.id}`)).json())
        .toMatchObject({ state: "ready", mutationAllowed: true });
      const trace = await (await page.request.get(`${fakeFusion}/trace`)).json() as { mutationCalls: number; hasSolid: boolean };
      expect(trace).toMatchObject({ mutationCalls: 1, hasSolid: false });
    });
  }

  test("cancellation stops the browser turn while the leased server action reaches trusted completion", async ({ page }) => {
    const conversation = await startAction(page, "delayed");
    await expect.poll(async () => (await (await page.request.get(`${fakeFusion}/trace`)).json() as { mutationCalls: number }).mutationCalls)
      .toBe(1);
    await page.getByTestId("composer-stop").click();
    await expectLifecycleBlocked(page, conversation.id, "competing-during-cancel");
    await expect.poll(async () => (await terminalRecords(page, conversation.id)).at(-1)?.event, { timeout: 30_000 }).toBe("completed");
    expect(await (await page.request.get(`/api/fusion/readiness?conversationId=${conversation.id}`)).json())
      .toMatchObject({ state: "ready", mutationAllowed: true });
    // The ledger is API-only in the chat-only Fusion workspace; a "-resolved"
    // reason records that trusted inspection resolved the interruption and no
    // recovery action remains.
    const resolved = (await terminalRecords(page, conversation.id)).findLast((record) => record.event === "completed");
    expect(resolved?.result.reason).toBe("canceled-resolved");
  });

  test("cancellation during post-action inspection remains diagnosed until trusted completion", async ({ page }) => {
    const conversation = await startAction(page, "delayed-inspection");
    await expect.poll(async () => (await (await page.request.get(`${fakeFusion}/trace`)).json() as { postInspectionStarted: boolean }).postInspectionStarted,
      { timeout: 30_000 }).toBe(true);
    await page.getByTestId("composer-stop").click();
    await expectLifecycleBlocked(page, conversation.id, "competing-during-inspection-cancel");
    await expect.poll(async () => (await terminalRecords(page, conversation.id)).findLast((record) => record.event === "completed")?.result.reason,
      { timeout: 30_000 }).toBe("canceled-resolved");
  });

  test("immediate verification failure is undone and verified before readiness returns", async ({ page }) => {
    const conversation = await startAction(page, "verification-failure");
    await expect.poll(async () => (await terminalRecords(page, conversation.id)).findLast((record) => record.event === "completed")?.result.status,
      { timeout: 90_000 }).toBe("rolled-back");
    const trace = await (await page.request.get(`${fakeFusion}/trace`)).json() as { mutationCalls: number; nativeUndoEntries: number; hasSolid: boolean };
    expect(trace).toMatchObject({ mutationCalls: 2, nativeUndoEntries: 0, hasSolid: false });
  });

  test("a stale pre-execution request is immutable and does not run a mutation", async ({ page }) => {
    const conversation = await startAction(page, "success");
    await expect.poll(async () => (await terminalRecords(page, conversation.id)).at(-1)?.event, { timeout: 90_000 }).toBe("completed");
    const inspection = await (await page.request.post(`/api/conversations/${conversation.id}/fusion-inspections`, { data: { checks: [] } })).json() as {
      current: { id: string; revision: string };
    };
    const before = await (await page.request.get(`${fakeFusion}/trace`)).json() as { mutationCalls: number };
    await page.request.post(`${fakeFusion}/manual/width/30`);
    const stale = await page.request.post(`/api/conversations/${conversation.id}/fusion-actions`, {
      data: boundedAction("stale-pre-execution", inspection.current.id, inspection.current.revision),
    });
    expect(stale.status()).toBe(409);
    const records = await terminalRecords(page, conversation.id);
    expect(records.at(-1)).toMatchObject({ event: "rejected", result: { reason: expect.stringMatching(/^(?:stale-revision|manual-edit)/) } });
    const after = await (await page.request.get(`${fakeFusion}/trace`)).json() as { mutationCalls: number };
    expect(after.mutationCalls).toBe(before.mutationCalls);
  });

  // Keep the persistent hard-recovery case last: by design no later mutation
  // on this endpoint is authorized in the same test server.
  test("failed Undo enters persistent hard recovery and exposes only read-only inspection", async ({ page }) => {
    const conversation = await startAction(page, "undo-failure");
    await expect.poll(async () => (await terminalRecords(page, conversation.id)).at(-1)?.result.reason, { timeout: 90_000 })
      .toBe("rollback-failure");
    await expect(page.getByTestId("fusion-recovery")).toContainText("Recovery required", { timeout: 30_000 });
    await expect(page.getByTestId("fusion-recovery")).toContainText(/inspect the resulting engineering state/i);
    expect(await (await page.request.get(`/api/fusion/readiness?conversationId=${conversation.id}`)).json())
      .toMatchObject({ state: "degraded", mutationAllowed: false, recovery: { state: "hard-recovery", failureClass: "undo-failure" } });
    await expectLifecycleBlocked(page, conversation.id, "blocked-after-hard-recovery");
  });
});
