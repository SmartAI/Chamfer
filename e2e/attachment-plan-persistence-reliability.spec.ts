import { expect, test, type Page } from "@playwright/test";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

async function expectPersistedDiagnostic(page: Page): Promise<void> {
  const failedRun = page.getByTestId("tool-call-card").filter({ hasText: "Plan conformance: FAILED" });
  await expect(failedRun).toContainText("Plan conformance: FAILED", { timeout: 60_000 });
  await expect(failedRun).toContainText('planned check "envelope" is missing');
  await expect(failedRun.getByTestId("tool-gate")).toHaveAttribute("data-status", "passed");
  await expect(failedRun.getByTestId("tool-measurements")).toContainText("10 x 10 x 10");
  await expect(failedRun.getByTestId("view-sheet-image")).toBeVisible();
  await expect(page.getByText("attachment-persist-failed", { exact: false })).toHaveCount(0);
}

test("persists and reloads a rendered plan-nonconforming CAD result", async ({ page }, testInfo) => {
  test.setTimeout(600_000);
  const conversationResponse = page.waitForResponse((response) =>
    response.request().method() === "POST" && new URL(response.url()).pathname === "/api/conversations"
  );
  await page.goto("/");
  await page.getByTestId("sidebar").getByRole("button", { name: "New chat", exact: true }).first().click();
  // A new chat first commits to a CAD environment; build123d is the default.
  await page.getByRole("dialog", { name: "Choose a CAD environment" })
    .getByRole("button", { name: "Start conversation" }).click();
  const conversation = await (await conversationResponse).json() as { id: string };
  const composer = page.getByTestId("composer-input");
  await expect(composer).toBeEnabled();
  await composer.fill("nonconforming-render: preserve the diagnostic result from this reference");
  await page.getByTestId("composer-file-input").setInputFiles({
    name: "diagnostic.png",
    mimeType: "image/png",
    buffer: PNG_1X1,
  });
  await page.getByTestId("composer-send").click();

  await expect(page.getByText("Diagnostic render preserved for plan repair.").last()).toBeVisible({ timeout: 600_000 });
  await expectPersistedDiagnostic(page);
  await page.screenshot({ path: testInfo.outputPath("nonconforming-render.png"), fullPage: true });

  const beforeReload = await (await page.request.get(`/api/conversations/${conversation.id}/messages`)).json() as Array<{
    id: string;
    seq: number;
    contentJson: string;
  }>;
  const durableRun = beforeReload
    .map((message) => ({ ...message, parsed: JSON.parse(message.contentJson) as Record<string, unknown> }))
    .find((message) => message.parsed.toolCallId === "nonconforming-render-run");
  expect(durableRun).toBeDefined();
  expect(durableRun?.parsed.isError).toBe(true);
  expect(durableRun?.parsed.details).toMatchObject({
    inspectionSheet: {
      code: { toolCallId: "nonconforming-render-run" },
      gate: { status: "passed" },
    },
  });
  const attachments = await (await page.request.get(`/api/messages/${durableRun!.id}/attachments`)).json() as Array<{
    kind: string;
  }>;
  expect(attachments.map((attachment) => attachment.kind)).toEqual(["view-sheet"]);

  await page.reload();
  await expectPersistedDiagnostic(page);

  await composer.fill("keep the diagnostic and continue later");
  await page.getByTestId("composer-send").click();
  await expect(page.getByText("Diagnostic render preserved for plan repair.").last()).toBeVisible({ timeout: 120_000 });
  const afterReloadSend = await (await page.request.get(`/api/conversations/${conversation.id}/messages`)).json() as Array<{
    seq: number;
  }>;
  expect(afterReloadSend.length).toBeGreaterThan(beforeReload.length);
  expect(Math.max(...afterReloadSend.map((message) => message.seq))).toBeGreaterThan(
    Math.max(...beforeReload.map((message) => message.seq)),
  );
});

test("allocates the first post-reload sequence above a seeded durable gap", async ({ page }) => {
  const conversation = await (await page.request.post("/api/conversations", {
    data: { title: "Sequence gap recovery", cadEnvironment: "build123d" },
  })).json() as { id: string };
  for (const [seq, text] of [[0, "sequence-gap-recovery: seeded start"], [3, "seeded message after gap"]] as const) {
    const response = await page.request.post(`/api/conversations/${conversation.id}/messages`, {
      data: {
        id: `gap-message-${seq}`,
        seq,
        role: "user",
        contentJson: JSON.stringify({ role: "user", content: text, timestamp: seq + 1 }),
      },
    });
    expect(response.ok()).toBe(true);
  }

  await page.goto("/");
  const composer = page.getByTestId("composer-input");
  await expect(composer).toBeEnabled();
  await expect(page.getByText("seeded message after gap")).toBeVisible();
  await composer.fill("persist immediately after reload");
  await page.getByTestId("composer-send").click();
  await expect(page.getByText("Sequence gap recovery complete.")).toBeVisible({ timeout: 120_000 });

  const messages = await (await page.request.get(`/api/conversations/${conversation.id}/messages`)).json() as Array<{
    seq: number;
    contentJson: string;
  }>;
  expect(messages.map((message) => message.seq)).toEqual([0, 3, 4, 5]);
  expect(messages.map((message) => JSON.parse(message.contentJson)).some(
    (message) => message.role === "user" && message.content?.[0]?.text === "persist immediately after reload",
  )).toBe(true);
});
