import type { Page } from "playwright";
import sharp from "sharp";
import type { EvaluationTask } from "./schema";
import { analyzeProductionConversation, type AnalyzedRun, type ProductionConversationSnapshot } from "./observation";

interface ConversationResponse {
  id: string;
}

interface SettingsResponse {
  modelJson?: string;
}

interface ModelConfiguration {
  provider?: unknown;
  id?: unknown;
}

function endpoint(baseUrl: string, path: string): string {
  return new URL(path, `${baseUrl.replace(/\/$/, "")}/`).toString();
}

async function responseJson<T>(page: Page, baseUrl: string, path: string): Promise<T> {
  const response = await page.request.get(endpoint(baseUrl, path));
  if (!response.ok()) throw new Error(`Evaluation API request failed: ${response.status()} ${path}`);
  return response.json() as Promise<T>;
}

function syntheticOrthographicDrawing(): Promise<Buffer> {
  return sharp(Buffer.from([
    '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">',
    '<rect width="512" height="512" fill="white"/>',
    '<path d="M140 140 H332 L372 180 V372 H140 Z" fill="#111827"/>',
    '<line x1="140" y1="405" x2="140" y2="455" stroke="#111827" stroke-width="3"/>',
    '<line x1="372" y1="405" x2="372" y2="455" stroke="#111827" stroke-width="3"/>',
    '<line x1="140" y1="440" x2="372" y2="440" stroke="#111827" stroke-width="4"/>',
    '<path d="M140 440 l18 -9 v18 Z M372 440 l-18 -9 v18 Z" fill="#111827"/>',
    '<rect x="218" y="421" width="76" height="30" rx="4" fill="white"/>',
    '<text x="256" y="443" text-anchor="middle" font-family="Arial, sans-serif" font-size="22" fill="#111827">10 mm</text>',
    '<text x="24" y="38" font-family="Arial, sans-serif" font-size="18" fill="#334155">FRONT ORTHOGRAPHIC</text>',
    '</svg>',
  ].join(""), "utf8")).png().toBuffer();
}

export class PlaywrightProductionSession {
  private initialized = false;

  constructor(
    private readonly page: Page,
    private readonly baseUrl: string,
  ) {}

  async run(task: EvaluationTask): Promise<ProductionConversationSnapshot> {
    if (!this.initialized) {
      await this.page.goto(this.baseUrl);
      const loading = this.page.getByText("Preparing environment, please wait...");
      if (await loading.count()) await loading.waitFor({ state: "hidden", timeout: 180_000 });
      this.initialized = true;
    }

    const settings = await responseJson<SettingsResponse>(this.page, this.baseUrl, "/api/settings");
    if (!settings.modelJson) throw new Error("Evaluation target has no configured model");
    const configured = JSON.parse(settings.modelJson) as ModelConfiguration;
    if (configured.provider !== task.modelConfiguration.provider || configured.id !== task.modelConfiguration.model) {
      throw new Error(
        `Evaluation model mismatch: expected ${task.modelConfiguration.provider}/${task.modelConfiguration.model}, ` +
        `found ${String(configured.provider)}/${String(configured.id)}`,
      );
    }

    const composer = this.page.getByTestId("composer-input");
    const created = this.page.waitForResponse((response) =>
      response.request().method() === "POST" && response.url().endsWith("/api/conversations"),
    );
    const messagesLoaded = this.page.waitForResponse((response) =>
      response.request().method() === "GET" && /\/api\/conversations\/[^/]+\/messages$/.test(response.url()),
    );
    const proofReportsLoaded = this.page.waitForResponse((response) =>
      response.request().method() === "GET" && /\/api\/conversations\/[^/]+\/proof-reports$/.test(response.url()),
    );
    await this.page.getByTestId("sidebar").getByRole("button", { name: "New chat", exact: true }).first().click();
    // Creation now goes through an explicit CAD-environment chooser; select the
    // Local build123d environment to trigger the conversation POST.
    const environmentDialog = this.page.getByRole("dialog", { name: "Choose a CAD environment" });
    await environmentDialog.waitFor({ state: "visible" });
    await environmentDialog.getByRole("radio", { name: /Local build123d/ }).check();
    await environmentDialog.getByRole("button", { name: "Start conversation" }).click();
    const conversation = await (await created).json() as ConversationResponse;
    const loadedUrls = [(await messagesLoaded).url(), (await proofReportsLoaded).url()];
    if (loadedUrls.some((url) => !url.includes(`/api/conversations/${conversation.id}/`))) {
      throw new Error(`Evaluation conversation switch loaded a different conversation than ${conversation.id}`);
    }
    await this.page.waitForFunction(() => {
      const input = document.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]');
      return input !== null && !input.disabled;
    }, undefined, { timeout: 60_000 });
    await composer.fill(task.prompt);
    if (task.attachment) {
      await this.page.getByTestId("composer-file-input").setInputFiles({
        name: task.attachment.name.replace(/\.[^.]+$/, ".png"),
        mimeType: "image/png",
        buffer: await syntheticOrthographicDrawing(),
      });
    }

    const firstPersist = this.page.waitForResponse((response) =>
      response.request().method() === "POST" &&
      response.url().includes(`/api/conversations/${conversation.id}/messages`),
    );
    const startedAt = performance.now();
    await this.page.getByTestId("composer-send").click();
    await firstPersist;
    const stop = this.page.getByTestId("composer-stop");
    await stop.waitFor({ state: "visible", timeout: 60_000 });
    await stop.waitFor({ state: "hidden", timeout: 600_000 });
    const elapsedMs = Math.round(performance.now() - startedAt);

    const [messages, proofContracts, artifacts, visualVerifications, proofReports] = await Promise.all([
      responseJson<ProductionConversationSnapshot["messages"]>(this.page, this.baseUrl, `/api/conversations/${conversation.id}/messages`),
      responseJson<ProductionConversationSnapshot["proofContracts"]>(this.page, this.baseUrl, `/api/conversations/${conversation.id}/proof-contracts`),
      responseJson<ProductionConversationSnapshot["artifacts"]>(this.page, this.baseUrl, `/api/conversations/${conversation.id}/artifacts`),
      responseJson<ProductionConversationSnapshot["visualVerifications"]>(this.page, this.baseUrl, `/api/conversations/${conversation.id}/visual-verifications`),
      responseJson<ProductionConversationSnapshot["proofReports"]>(this.page, this.baseUrl, `/api/conversations/${conversation.id}/proof-reports`),
    ]);
    return {
      messages,
      proofContracts,
      artifacts,
      visualVerifications,
      proofReports,
      elapsedMs,
      configuredProvider: task.modelConfiguration.provider,
      configuredModel: task.modelConfiguration.model,
    };
  }
}

export interface ProductionSession {
  run(task: EvaluationTask): Promise<ProductionConversationSnapshot>;
}

/**
 * Evaluation orchestration delegates the entire turn to Chamfer's production session seam.
 * It only analyzes the durable result after that session settles.
 */
export async function evaluateThroughProductionSession(
  session: ProductionSession,
  task: EvaluationTask,
  promptVersion: string,
): Promise<AnalyzedRun> {
  return analyzeProductionConversation(task, await session.run(task), promptVersion);
}
