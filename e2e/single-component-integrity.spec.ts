import { expect, test } from "@playwright/test";

test("preserves detached diagnostic geometry, blocks completion, then accepts one corrected solid", async ({ page }, testInfo) => {
  test.setTimeout(600_000);
  await page.goto("/");
  await page.getByTestId("sidebar").getByRole("button", { name: "New chat", exact: true }).first().click();
  // A new chat first commits to a CAD environment; build123d is the default.
  await page.getByRole("dialog", { name: "Choose a CAD environment" })
    .getByRole("button", { name: "Start conversation" }).click();

  const composer = page.getByTestId("composer-input");
  await expect(composer).toBeEnabled();
  await composer.fill("single-component-integrity: build one connected 30 x 20 x 4 mm plate");
  await page.getByTestId("composer-send").click();

  await expect(page.getByText("Detached integrity diagnostic remains visible", { exact: false }).first()).toBeVisible({
    timeout: 600_000,
  });
  await expect(page.getByTestId("viewer")).toHaveAttribute("data-has-geometry", "true");
  await expect(page.getByTestId("plan-progress")).toHaveText("0/1 components");
  await page.getByTestId("plan-card-toggle").click();
  await expect(page.getByTestId("plan-component")).toHaveAttribute("data-status", "blocked");
  await expect(page.getByTestId("plan-blocked-reason")).toContainText("disconnected geometry");
  await expect(page.getByTestId("proof-contract-card")).toHaveAttribute("data-proof-status", "pending");

  const gates = page.getByTestId("tool-gate");
  await expect(gates).toHaveCount(1);
  await expect(gates.first()).toHaveAttribute("data-status", "failed");
  await expect(gates.first()).toContainText("single_component_integrity");
  await expect(gates.first()).toContainText('Component "plate" has disconnected geometry');
  await expect(page.getByTestId("tool-integrity").first()).toHaveAttribute("data-status", "nonconforming");
  await expect(page.getByTestId("tool-integrity").first()).toContainText("2 connected solids");

  const conversations = await (await page.request.get("/api/conversations")).json() as Array<{ id: string }>;
  const conversationId = conversations[0]!.id;
  const initialMessages = await (await page.request.get(`/api/conversations/${conversationId}/messages`)).json() as Array<{
    contentJson: string;
  }>;
  const detachedResult = initialMessages
    .map(({ contentJson }) => JSON.parse(contentJson) as {
      role?: string;
      toolCallId?: string;
      isError?: boolean;
      details?: {
        gate?: { status?: string };
        measurements?: { integrity?: { status?: string; componentId?: string; solidCount?: number; valid?: boolean } };
      };
    })
    .find((message) => message.role === "toolResult" && message.toolCallId === "integrity-run-detached");
  expect(detachedResult).toMatchObject({
    isError: false,
    details: {
      gate: { status: "failed" },
      measurements: {
        integrity: {
          status: "nonconforming",
          componentId: "plate",
          solidCount: 2,
          valid: true,
        },
      },
    },
  });
  expect(await (await page.request.get(`/api/conversations/${conversationId}/artifacts`)).json()).toHaveLength(1);
  await page.getByTestId("tool-integrity").first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("detached-integrity-diagnostic.png"), fullPage: true });

  await composer.fill("integrity-correct: join the detached feature into one valid solid and retry completion");
  await page.getByTestId("composer-send").click();
  await expect(page.getByText("Corrected single-solid plate is current", { exact: false }).first()).toBeVisible({
    timeout: 600_000,
  });

  await expect(page.getByTestId("plan-progress")).toHaveText("1/1 components");
  await expect(gates).toHaveCount(2);
  await expect(gates.nth(1)).toHaveAttribute("data-status", "passed");
  await expect(page.getByTestId("tool-integrity").nth(1)).toHaveAttribute("data-status", "conforming");
  await expect(page.getByTestId("tool-integrity").nth(1)).toContainText("1 connected solid");
  expect(await (await page.request.get(`/api/conversations/${conversationId}/artifacts`)).json()).toHaveLength(2);
  await page.getByTestId("tool-integrity").nth(1).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("corrected-single-solid.png"), fullPage: true });
});
