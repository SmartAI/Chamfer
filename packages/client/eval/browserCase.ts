import type { AgentRunLifecycleDto } from "@chamfer/shared";
import type { Browser, Page } from "playwright";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import sharp from "sharp";
import { evaluatePersistedCase, type PersistedArtifact, type PersistedMessage } from "./evaluate";
import type { EvaluationCase } from "./schema";
import { mergeLifecycleMeasurements } from "./lifecycleMeasurements";

export async function persistRenderedCanvasEvidence(input: {
  screenshot: Buffer;
  rawEvidenceDir: string;
  filename: string;
}): Promise<{ reference: string; nonblank: true }> {
  const statistics = await sharp(input.screenshot).stats();
  const nonblank = statistics.channels.slice(0, 3).some((channel) => channel.stdev > 1);
  if (!nonblank) throw new Error("Rendered viewer canvas is blank or uniform");
  await mkdir(input.rawEvidenceDir, { recursive: true });
  await writeFile(resolve(input.rawEvidenceDir, input.filename), input.screenshot, { mode: 0o600 });
  const hash = createHash("sha256").update(input.screenshot).digest("hex");
  return {
    reference: `raw/screenshots/${input.filename}#sha256:${hash}`,
    nonblank: true,
  };
}

async function loadCompletedLifecycle(
  page: Page,
  clientUrl: string,
  conversationId: string,
): Promise<AgentRunLifecycleDto | undefined> {
  const deadline = Date.now() + 5_000;
  let supported = false;
  while (Date.now() < deadline) {
    const response = await page.request.get(`${clientUrl}/api/conversations/${conversationId}/agent-runs/latest`);
    if (response.ok()) {
      const lifecycle = await response.json() as AgentRunLifecycleDto;
      if (lifecycle.status === "completed") return lifecycle;
      supported = true;
    } else if (response.status() === 404 && response.headers()["content-type"]?.includes("application/json")) {
      supported = true;
    } else if (response.status() === 404) {
      return undefined;
    } else {
      throw new Error(`Could not load agent lifecycle evidence: ${response.status()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (supported) throw new Error("Agent lifecycle evidence did not reach its durable completion barrier");
  return undefined;
}

export async function runBrowserCase(input: {
  browser: Browser;
  clientUrl: string;
  evaluationCase: EvaluationCase;
  evaluationIdentity: {
    caseExecutionId: string;
    caseId: string;
    corpusVersion: string;
    repetition: number;
  };
  rawEvidenceDir: string;
}): Promise<ReturnType<typeof evaluatePersistedCase>> {
  const context = await input.browser.newContext();
  const page = await context.newPage();
  try {
    const clientUrl = new URL(input.clientUrl);
    clientUrl.searchParams.set("evaluationCaseExecutionId", input.evaluationIdentity.caseExecutionId);
    clientUrl.searchParams.set("evaluationCaseId", input.evaluationIdentity.caseId);
    clientUrl.searchParams.set("evaluationCorpusVersion", input.evaluationIdentity.corpusVersion);
    clientUrl.searchParams.set("evaluationRepetition", String(input.evaluationIdentity.repetition));
    await page.goto(clientUrl.href);
    const loading = page.getByText("Preparing environment, please wait...");
    if (await loading.count()) await loading.waitFor({ state: "hidden", timeout: 180_000 });
    const createdResponse = page.waitForResponse((response) =>
      response.request().method() === "POST" && response.url().endsWith("/api/conversations")
    );
    await page.getByTestId("sidebar").getByRole("button", { name: "New chat", exact: true }).first().click();
    // Creation now goes through an explicit CAD-environment chooser; select the
    // Local build123d environment to trigger the conversation POST.
    const environmentDialog = page.getByRole("dialog", { name: "Choose a CAD environment" });
    await environmentDialog.waitFor({ state: "visible" });
    await environmentDialog.getByRole("radio", { name: /Local build123d/ }).check();
    await environmentDialog.getByRole("button", { name: "Start conversation" }).click();
    const conversation = await (await createdResponse).json() as { id: string };

    for (const turn of input.evaluationCase.inputs.turns) {
      const composer = page.getByTestId("composer-input");
      await composer.waitFor({ state: "visible" });
      await composer.fill(turn.text);
      if (turn.assetIds?.length) {
        const assetPaths = turn.assetIds.map((assetId) => {
          const asset = input.evaluationCase.inputs.assets.find((candidate) => candidate.id === assetId);
          if (!asset) throw new Error(`Input references missing asset ${assetId}`);
          return resolve(import.meta.dirname, "cases/v1", asset.path);
        });
        await page.getByTestId("composer-file-input").setInputFiles(assetPaths);
        await page.getByTestId("composer-attachment").last().waitFor({ state: "visible" });
        const attached = await page.getByTestId("composer-attachment").count();
        if (attached !== assetPaths.length) {
          throw new Error(`Expected ${assetPaths.length} ready image assets, found ${attached}`);
        }
      }
      await page.getByTestId("composer-send").click();
      await page.getByTestId("generation-status").getByText("Agent is working").waitFor({
        state: "visible",
        timeout: 10_000,
      });
      const error = page.getByTestId("error-banner");
      const settlement = await Promise.race([
        page.getByTestId("generation-status").getByText("Done").waitFor({
          state: "visible",
          timeout: 600_000,
        }).then(() => "done" as const),
        error.waitFor({ state: "visible", timeout: 600_000 }).then(() => "error" as const),
      ]);
      if (settlement === "error") throw new Error((await error.textContent()) ?? "Agent execution failed");
    }

    const messagesResponse = await page.request.get(
      `${input.clientUrl}/api/conversations/${conversation.id}/messages`,
    );
    if (!messagesResponse.ok()) throw new Error(`Could not load persisted messages: ${messagesResponse.status()}`);
    const messages = await messagesResponse.json() as PersistedMessage[];
    const artifactsResponse = await page.request.get(
      `${input.clientUrl}/api/conversations/${conversation.id}/artifacts`,
    );
    if (!artifactsResponse.ok()) throw new Error(`Could not load persisted artifacts: ${artifactsResponse.status()}`);
    const artifacts = await artifactsResponse.json() as PersistedArtifact[];
    const lifecycle = await loadCompletedLifecycle(page, input.clientUrl, conversation.id);

    await page.reload();
    if (input.evaluationCase.expectedOutcome.kind === "completed") {
      await page.getByTestId("tool-call-card").first().waitFor({ state: "visible", timeout: 60_000 });
    }
    let visualCanvasEvidence: { reference: string; nonblank: boolean } | undefined;
    if (input.evaluationCase.inputs.assets.length > 0 && input.evaluationCase.expectedOutcome.kind === "completed") {
      const viewer = page.getByTestId("viewer");
      await viewer.waitFor({ state: "visible", timeout: 60_000 });
      await page.waitForFunction(() =>
        document.querySelector<HTMLElement>('[data-testid="viewer"]')?.dataset.hasGeometry === "true",
      undefined, { timeout: 60_000 });
      const canvas = viewer.locator("canvas");
      await canvas.waitFor({ state: "visible", timeout: 60_000 });
      const screenshot = await canvas.screenshot({ animations: "disabled" });
      const filename = `${input.evaluationIdentity.caseExecutionId}-canvas.png`;
      visualCanvasEvidence = await persistRenderedCanvasEvidence({
        screenshot,
        rawEvidenceDir: input.rawEvidenceDir,
        filename,
      });
    }
    const evaluated = evaluatePersistedCase({
      evaluationCase: input.evaluationCase,
      conversationId: conversation.id,
      messages,
      artifacts,
      visualCanvasEvidence,
    });
    return lifecycle
      ? { ...evaluated, measurements: mergeLifecycleMeasurements({ measurements: evaluated.measurements, lifecycle }) }
      : evaluated;
  } finally {
    await context.close();
  }
}
