import { expect, test } from "@playwright/test";
import { FUS_TEXT_001 } from "@chamfer/fusion-fixtures";
import { clearConversations } from "./helpers";

async function startFusionFixture(page: import("@playwright/test").Page): Promise<{ id: string }> {
  await page.goto("about:blank");
  await clearConversations(page);
  await page.goto("/");
  const created = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/api/conversations"));
  await page.getByTestId("sidebar").getByRole("button", { name: "New chat", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "Choose a CAD environment" });
  await dialog.getByRole("radio", { name: /Autodesk Fusion/ }).check();
  await dialog.getByRole("button", { name: "Start conversation" }).click();
  return await (await created).json() as { id: string };
}

test("FUS-TEXT-001 completes through the production agent and stable fixture contract", async ({ page }) => {
  await page.request.post("http://127.0.0.1:8997/control/ready");
  await page.request.post("http://127.0.0.1:8997/trace/reset");
  const conversation = await startFusionFixture(page);

  await page.getByTestId("composer-input").fill(FUS_TEXT_001.prompt);
  await page.getByTestId("composer-send").click();
  // The deterministic plan stop-gate can nudge the scripted fake into restating
  // its final text; assert presence, not uniqueness.
  await expect(page.getByText(/FUS-TEXT-001 is complete on one inspected Fusion revision/).first()).toBeVisible({ timeout: 90_000 });

  const records = await (await page.request.get(`/api/conversations/${conversation.id}/fusion-actions`)).json() as Array<{
    event: string;
    expectedEffects: unknown[];
    result: { checks?: Array<{ status: string }> };
  }>;
  expect(records.map((record) => record.event)).toEqual(["attempt", "completed"]);
  // Public action history is the privacy-safe audit projection: typed kinds and
  // numeric thresholds remain inspectable while descriptive strings are hashed.
  expect((records.at(-1)?.expectedEffects as Array<{ kind: string }>).map((effect) => effect.kind))
    .toEqual(FUS_TEXT_001.expectedEffects.map((effect) => effect.kind));
  expect(JSON.stringify(records.at(-1)?.expectedEffects)).not.toContain("plate_length");
  expect(records.at(-1)?.result.checks).not.toContainEqual(expect.objectContaining({ status: "failed" }));
  expect(records.at(-1)?.result.checks).not.toContainEqual(expect.objectContaining({ status: "unsupported" }));
  expect(records.at(-1)?.result).toMatchObject({ status: "completed", undoEntries: 1 });

  const trace = await (await page.request.get("http://127.0.0.1:8997/trace")).json() as Record<string, unknown>;
  expect(trace).toMatchObject({ mutationCalls: 1, nativeUndoEntries: 1, hasSolid: true, model: "plate" });
});

test("FUS-TEXT-001 forbidden outcomes remain failed or rolled back instead of completing", async ({ page }) => {
  for (const variant of ["direct", "omitted-feature", "wrong-material", "wrong-appearance", "displaced-camera", "wrong-dimensions", "extra-history", "wrong-document", "unsupported-verification"] as const) {
    await page.request.post("http://127.0.0.1:8997/control/ready");
    await page.request.post("http://127.0.0.1:8997/trace/reset");
    await page.request.post(`http://127.0.0.1:8997/fixture/${variant}`);
    const conversation = await startFusionFixture(page);
    await page.getByTestId("composer-input").fill(FUS_TEXT_001.prompt);
    await page.getByTestId("composer-send").click();
    // The deterministic plan stop-gate nudges the agent once before accepting a
    // stop with unfinished plan work, so the scripted fake restates its
    // assessment; assert presence, not uniqueness.
    await expect(page.getByText(/FUS-TEXT-001 did not complete/).first()).toBeVisible({ timeout: 90_000 });
    await expect(page.getByText(/FUS-TEXT-001 is complete on one inspected Fusion revision/)).toHaveCount(0);
    const records = await (await page.request.get(`/api/conversations/${conversation.id}/fusion-actions`)).json() as Array<{
      event: string;
      result: { status?: string; checks?: Array<{ status: string }> };
    }>;
    const status = records.findLast((record) => typeof record.result.status === "string")?.result.status;
    if (["direct", "wrong-document", "unsupported-verification"].includes(variant)) {
      // Structural breakage or a pre-mutation rejection still terminates hard.
      expect(status ?? records.at(-1)?.event, variant).toMatch(/rolled-back|rejected|failed/);
    } else {
      // Deferred verification: a structurally sound action completes and its
      // recorded checks carry the mismatch; the final completion inspection is
      // what refuses the done transition (asserted above via the visible
      // "did not complete" message and the absent completion claim).
      expect(status, variant).toBe("completed");
      expect(records.flatMap((record) => record.result.checks ?? []).some((check) => check.status !== "passed"), variant).toBe(true);
    }
    if (variant === "displaced-camera") {
      expect(await (await page.request.get(`/api/fusion/readiness?conversationId=${conversation.id}`)).json())
        .toMatchObject({ state: "degraded", mutationAllowed: false });
      // The strip derives this notice from the readiness poll (8s cadence).
      await expect(page.getByTestId("fusion-camera-recovery")).toContainText("Engineering state is unchanged", { timeout: 20_000 });
      await expect(page.getByTestId("fusion-camera-recovery")).toContainText("restore the camera in Fusion");
    }
  }
});
