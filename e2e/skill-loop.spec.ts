import { expect, test } from "@playwright/test";

// Exercises the progressive-disclosure skill layer against the scripted fake LLM
// ("skill-loop" scenario): the model loads the sweep-and-loft skill from the
// catalog, fetches its diagnostic-probe resource, and repeats the first load to
// prove dedupe. No CAD run is involved, so the spec does not wait on Pyodide.
test("skill loop loads a skill, fetches a resource, and dedupes the repeat load", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/");
  // Capture this spec's conversation id at creation: the suite shares one
  // database, so listing conversations would race with other specs' chats.
  const created = page.waitForResponse(
    (response) => response.request().method() === "POST" && response.url().endsWith("/api/conversations"),
  );
  await page.getByTestId("sidebar").getByRole("button", { name: "New chat", exact: true }).first().click();
  const conversation = (await (await created).json()) as { id: string };
  const composer = page.getByTestId("composer-input");
  await expect(composer).toBeEnabled();
  await composer.fill("skill-loop: sweep a handle");
  await page.getByTestId("composer-send").click();

  await expect(page.getByText("Skill loop complete")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("tool-call-card").filter({ hasText: "load_skill" })).toHaveCount(3);

  // The persisted transcript carries the real payloads; assert on it, not the UI
  // chrome. Persistence is async behind the streamed reply, so poll for all three.
  const fetchLoadResults = async () => {
    const messages = await (
      await page.request.get(`/api/conversations/${conversation.id}/messages`)
    ).json();
    return messages
      .map((m: { contentJson: string }) => JSON.parse(m.contentJson) as { role?: string; toolName?: string; content?: Array<{ text?: string }> })
      .filter((m: { role?: string; toolName?: string }) => m.role === "toolResult" && m.toolName === "load_skill")
      .map((m: { content?: Array<{ text?: string }> }) => (m.content ?? []).map((block) => block.text ?? "").join("\n"));
  };
  await expect.poll(async () => (await fetchLoadResults()).length, { timeout: 30_000 }).toBe(3);
  const loadResults = await fetchLoadResults();
  expect(loadResults[0]).toContain('<skill name="sweep-and-loft" location="skills/sweep-and-loft/SKILL.md">');
  expect(loadResults[0]).toContain("Plane(origin=path @ 0, z_dir=path % 0)");
  expect(loadResults[1]).toContain('<skill-resource skill="sweep-and-loft" path="snippets/sweep_diagnose.py">');
  expect(loadResults[2]).toContain("already in context");
});
