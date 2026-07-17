import { expect, test } from "@playwright/test";
import { startBuild123dConversation } from "./helpers";

/**
 * Full plan-artifact loop against the scripted fake LLM (CHAMFER_FAKE_LLM=1):
 * the agent plans two components, builds the base, records it done
 * (evidence-checked against the gate), stops prematurely, gets the
 * deterministic plan nudge, builds the assembly, and completes the plan.
 */
test("plan artifact loop: plan card, evidence-checked progress, stop-gate nudge", async ({ page }) => {
  test.setTimeout(600_000);
  await page.goto("/");
  await startBuild123dConversation(page);
  const composer = page.getByTestId("composer-input");
  await expect(composer).toBeEnabled();
  await composer.fill("plan-flow: build a base plate with a lid resting on it");
  await page.getByTestId("composer-send").click();

  // The accepted plan renders as the live card with both components pending.
  const planCard = page.getByTestId("plan-card");
  await expect(planCard).toBeVisible({ timeout: 600_000 });
  await expect(planCard).toHaveAttribute("data-plan-format", "domain-operations-v1");
  await expect(page.getByTestId("plan-progress")).toHaveText("0/2 components");

  // Base run passes its gate and an explicit status operation records it done.
  await expect(page.getByTestId("plan-progress")).toHaveText("1/2 components", { timeout: 600_000 });

  // The premature stop draws the deterministic plan nudge as a system chip.
  await expect(page.getByTestId("plan-nudge-chip")).toBeVisible({ timeout: 600_000 });

  // The nudge forces the assembly run; the plan completes and the turn ends.
  await expect(page.getByTestId("plan-progress")).toHaveText("2/2 components", { timeout: 600_000 });
  await expect(page.getByTestId("plan-revision")).toHaveText("Revision 3 · criteria 1");
  await expect(page.getByText("Assembly complete", { exact: false }).first()).toBeVisible({ timeout: 600_000 });

  // The conversation badge reflects the assembly's passing gate.
  await expect(page.getByTestId("verify-chip")).toHaveAttribute("data-status", "passed");

  // Expanded card: both components ticked done.
  await page.getByTestId("plan-card-toggle").click();
  const components = page.getByTestId("plan-component");
  await expect(components).toHaveCount(2);
  const entityIds = await components.evaluateAll((items) => items.map((item) => item.getAttribute("data-entity-id")));
  expect(entityIds.every(Boolean)).toBe(true);
  expect(new Set(entityIds).size).toBe(2);
  await expect(components.nth(0)).toHaveAttribute("data-status", "done");
  await expect(components.nth(1)).toHaveAttribute("data-status", "done");

  // Replay: the plan card and statuses survive a reload (derived from the transcript).
  await page.reload();
  await expect(page.getByTestId("plan-card")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("plan-card")).toHaveAttribute("data-plan-format", "domain-operations-v1");
  await expect(page.getByTestId("plan-progress")).toHaveText("2/2 components");
  await page.getByTestId("plan-card-toggle").click();
  expect(await page.getByTestId("plan-component").evaluateAll((items) =>
    items.map((item) => item.getAttribute("data-entity-id")),
  )).toEqual(entityIds);

  const conversationsResponse = await page.request.get("/api/conversations");
  expect(conversationsResponse.ok()).toBe(true);
  const conversations = await conversationsResponse.json() as Array<{ id: string }>;
  const operationConversationId = conversations[0]!.id;
  const messagesResponse = await page.request.get(`/api/conversations/${operationConversationId}/messages`);
  expect(messagesResponse.ok()).toBe(true);
  const persistedMessages = await messagesResponse.json() as Array<{ contentJson: string }>;
  const messages = persistedMessages.map((message) => JSON.parse(message.contentJson) as {
    role?: string;
    toolName?: string;
    isError?: boolean;
    details?: { plan?: Record<string, unknown> };
    content?: Array<{ type?: string; name?: string; arguments?: Record<string, unknown> }>;
  });
  const acceptedPlans = messages.filter((message) =>
    message.role === "toolResult" &&
    (message.toolName === "create_plan" || message.toolName === "revise_plan") &&
    !message.isError,
  );
  expect(acceptedPlans).toHaveLength(3);
  const initialPlan = acceptedPlans[0]!.details!.plan as {
    domain: { revision: number; criteria_revision: number; source_specification_ids: string[]; history: unknown[] };
    components: Array<{ id: string }>;
  };
  const finalPlan = acceptedPlans[2]!.details!.plan as typeof initialPlan;
  expect(initialPlan.domain).toMatchObject({
    revision: 1,
    criteria_revision: 1,
    source_specification_ids: ["base-present", "lid-resting"],
  });
  expect(finalPlan.domain).toMatchObject({ revision: 3, criteria_revision: 1 });
  expect(finalPlan.domain.history).toHaveLength(3);
  expect(finalPlan.components.map((component) => component.id)).toEqual(initialPlan.components.map((component) => component.id));
  expect(finalPlan.components.every((component) => !("entity_id" in component))).toBe(true);
  const revisionCalls = messages.flatMap((message) =>
    message.content?.filter((block) => block.type === "toolCall" && block.name === "revise_plan") ?? [],
  );
  expect(revisionCalls).toHaveLength(2);
  expect(revisionCalls.every((call) =>
    Array.isArray(call.arguments?.operations) && call.arguments?.components === undefined && call.arguments?.goal === undefined,
  )).toBe(true);

  // A legacy snapshot conversation remains readable in the same browser session.
  const legacyConversationResponse = await page.request.post("/api/conversations", {
    data: { title: "Legacy snapshot plan", cadEnvironment: "build123d" },
  });
  expect(legacyConversationResponse.ok()).toBe(true);
  const legacyConversation = await legacyConversationResponse.json() as { id: string };
  const legacyPlan = {
    goal: "legacy spacer",
    components: [{
      id: "spacer",
      description: "legacy 10 mm spacer",
      bbox_mm: [10, 10, 10],
      checks: [{ id: "volume", kind: "volume", range_mm3: [900, 1100], target: "spacer" }],
      status: "todo",
      free_floating_reason: "single part",
    }],
    interfaces: [],
  };
  const legacyMessageResponse = await page.request.post(`/api/conversations/${legacyConversation.id}/messages`, {
    data: {
      id: "legacy-plan-result",
      seq: 0,
      role: "toolResult",
      contentJson: JSON.stringify({
        role: "toolResult",
        toolCallId: "legacy-plan-call",
        toolName: "update_plan",
        content: [{ type: "text", text: "Plan accepted" }],
        details: { plan: legacyPlan },
        isError: false,
        timestamp: 1,
      }),
    },
  });
  expect(legacyMessageResponse.ok()).toBe(true);
  await page.reload();
  await page.getByTestId("sidebar").getByRole("button", { name: "Legacy snapshot plan", exact: true }).click();
  await expect(page.getByTestId("plan-card")).toHaveAttribute("data-plan-format", "legacy-snapshot");
  await expect(page.getByTestId("plan-progress")).toHaveText("0/1 components");
});
