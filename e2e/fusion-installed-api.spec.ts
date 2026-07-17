import { expect, test } from "@playwright/test";
import { clearConversations } from "./helpers";

test("Fusion agent answers from installed API guidance without mutating the document", async ({ page }) => {
  await page.goto("/");
  // Without this, a conversation left over from an earlier spec still owns the
  // fake Fusion document and this conversation binds read-only (no composer).
  await clearConversations(page);
  await page.reload();
  const created = page.waitForResponse((response) =>
    response.request().method() === "POST" && response.url().endsWith("/api/conversations"));
  await page.getByTestId("sidebar").getByRole("button", { name: "New chat", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "Choose a CAD environment" });
  await dialog.getByRole("radio", { name: /Autodesk Fusion/ }).check();
  await dialog.getByRole("button", { name: "Start conversation" }).click();
  const conversation = await (await created).json() as { id: string };
  await page.request.post("http://127.0.0.1:8997/trace/reset");

  await page.getByTestId("composer-input").fill("fusion-installed-api: How does ExtrudeFeatureInput set a distance extent?");
  await page.getByTestId("composer-send").click();

  // The deterministic plan stop-gate can nudge the scripted fake into restating
  // its final text; assert presence, not uniqueness.
  await expect(page.getByText(/Installed Fusion 2704\.1\.23 guidance says/).first()).toBeVisible({ timeout: 60_000 });
  const fetchMessages = async () =>
    await (await page.request.get(`/api/conversations/${conversation.id}/messages`)).json() as Array<{ contentJson: string }>;
  await expect.poll(async () => (await fetchMessages()).length, { timeout: 30_000 }).toBeGreaterThanOrEqual(4);
  const messages = await fetchMessages();
  const transcript = JSON.stringify(messages.map((item) => JSON.parse(item.contentJson)));
  expect(transcript).toContain('"toolName":"search_fusion_docs"');
  expect(transcript).toContain('"fusionVersion":"2704.1.23"');
  expect(transcript).not.toContain('"toolName":"fusion_mcp_read"');
  expect(transcript).not.toContain('"toolName":"run_build123d"');

  const trace = await page.request.get("http://127.0.0.1:8997/trace");
  const traceBody = await trace.json() as { documentationReads: number; mutationCalls: number };
  expect(traceBody.documentationReads).toBeGreaterThanOrEqual(1);
  expect(traceBody.mutationCalls).toBe(0);
});
