import { expect, test } from "@playwright/test";

test("legacy snapshot writes are rejected and recover through domain operations", async ({ page }) => {
  test.setTimeout(600_000);
  await page.goto("/");

  const conversationResponse = await page.request.post("/api/conversations", {
    data: { title: "Legacy recovery plan", cadEnvironment: "build123d" },
  });
  expect(conversationResponse.ok()).toBe(true);
  const conversation = await conversationResponse.json() as { id: string };
  const legacyPlan = {
    goal: "legacy spacer",
    components: [{
      id: "spacer",
      description: "legacy 10 mm spacer",
      bbox_mm: [10, 10, 10],
      checks: [
        { id: "envelope", kind: "bbox", size_mm: [10, 10, 10], target: "spacer" },
        { id: "volume", kind: "volume", range_mm3: [900, 1100], target: "spacer" },
      ],
      status: "building",
      free_floating_reason: "single part",
    }],
    interfaces: [],
  };
  const seedResponse = await page.request.post(`/api/conversations/${conversation.id}/messages`, {
    data: {
      id: "legacy-recovery-seed-result",
      seq: 0,
      role: "toolResult",
      contentJson: JSON.stringify({
        role: "toolResult",
        toolCallId: "legacy-recovery-seed-call",
        toolName: "update_plan",
        content: [{ type: "text", text: "Plan accepted" }],
        details: { plan: legacyPlan },
        isError: false,
        timestamp: 1,
      }),
    },
  });
  expect(seedResponse.ok()).toBe(true);

  await page.reload();
  await page.getByTestId("sidebar").getByRole("button", { name: "Legacy recovery plan", exact: true }).click();
  await expect(page.getByTestId("plan-card")).toHaveAttribute("data-plan-format", "legacy-snapshot");
  await page.getByTestId("plan-card-toggle").click();
  await expect(page.locator("#plan-check-spacer-envelope")).toBeVisible();
  await expect(page.locator("#plan-check-spacer-volume")).toBeVisible();

  const composer = page.getByTestId("composer-input");
  await composer.fill("legacy-plan-recovery: preserve the complete legacy spacer plan");
  await page.getByTestId("composer-send").click();

  const rejectedWrite = page.getByRole("button", { name: "Updated plan Failed", exact: true });
  await rejectedWrite.click();
  await expect(rejectedWrite.locator("..")).toContainText("stored legacy snapshot remains unchanged", {
    timeout: 60_000,
  });
  await expect(rejectedWrite.locator("..")).toContainText("transition_from_legacy=true");

  await expect(page.getByText("Legacy plan preserved and transitioned", { exact: false })).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByTestId("plan-card")).toHaveAttribute("data-plan-format", "domain-operations-v1");
  await expect(page.getByTestId("plan-revision")).toHaveText("Revision 2 · criteria 1");
  const component = page.getByTestId("plan-component");
  await expect(component).toHaveAttribute("data-status", "blocked");
  await expect(page.getByTestId("plan-blocked-reason")).toContainText("Waiting for material selection");
  await expect(page.locator("#plan-check-spacer-envelope")).toBeVisible();
  await expect(page.locator("#plan-check-spacer-volume")).toBeVisible();

  const messagesResponse = await page.request.get(`/api/conversations/${conversation.id}/messages`);
  expect(messagesResponse.ok()).toBe(true);
  const persisted = await messagesResponse.json() as Array<{ contentJson: string }>;
  const messages = persisted.map((row) => JSON.parse(row.contentJson) as {
    role?: string;
    toolName?: string;
    toolCallId?: string;
    isError?: boolean;
    details?: { plan?: { components?: Array<{ checks?: Array<{ id?: string }> }> } };
    content?: Array<{ type?: string; name?: string; arguments?: Record<string, unknown> }>;
  });
  const rejectedResult = messages.find((message) => message.toolCallId === "legacy-recovery-write");
  expect(rejectedResult).toMatchObject({ role: "toolResult", toolName: "update_plan", isError: true });
  expect(rejectedResult?.details?.plan).toBeUndefined();

  const acceptedSnapshots = messages.filter((message) =>
    message.role === "toolResult" && message.toolName === "update_plan" && !message.isError,
  );
  expect(acceptedSnapshots).toHaveLength(1);
  expect(acceptedSnapshots[0]?.details?.plan?.components?.[0]?.checks?.map((check) => check.id)).toEqual([
    "envelope",
    "volume",
  ]);

  const domainResults = messages.filter((message) =>
    message.role === "toolResult" &&
    (message.toolName === "create_plan" || message.toolName === "revise_plan") &&
    !message.isError,
  );
  expect(domainResults).toHaveLength(2);
  expect(domainResults[1]?.details?.plan?.components?.[0]?.checks?.map((check) => check.id)).toEqual([
    "envelope",
    "volume",
  ]);

  const calls = messages.flatMap((message) => message.content?.filter((block) => block.type === "toolCall") ?? []);
  const transition = calls.find((call) => call.name === "create_plan")?.arguments;
  expect(transition).toMatchObject({ transition_from_legacy: true });
  expect(JSON.stringify(transition)).not.toMatch(
    /"(?:entity_id|criteria_revision|retired_revision|revision_reason|refit_to_measurement|history)"/,
  );
  const revision = calls.find((call) => call.name === "revise_plan")?.arguments;
  expect(revision).toMatchObject({
    operations: [{ kind: "set_component_status", component_id: "spacer", status: "blocked" }],
  });
  expect(revision).not.toHaveProperty("components");
  expect(revision).not.toHaveProperty("goal");
});
