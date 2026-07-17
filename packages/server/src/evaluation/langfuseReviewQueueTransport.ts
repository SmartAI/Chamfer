import { createHash } from "node:crypto";
import type { ReviewQueueTransport, ReviewScoreConfig } from "./reviewQueue";

type FetchLike = typeof fetch;
type Env = Record<string, string | undefined>;

interface Page<T> {
  data: T[];
  meta: { page: number; totalPages: number };
}

interface RemoteScoreConfig {
  id: string;
  name: string;
  dataType: string;
  categories: Array<{ label: string; value: number }> | null;
  isArchived: boolean;
}

interface RemoteQueue {
  id: string;
  name: string;
  scoreConfigIds: string[];
}

interface RemoteQueueItem {
  id: string;
  objectId: string;
}

class LangfuseReviewQueueHttpError extends Error {
  constructor(readonly status: number) {
    super(`Langfuse review queue request failed (HTTP ${status})`);
  }
}

function configCore(config: Pick<ReviewScoreConfig, "name" | "dataType" | "categories">) {
  return { name: config.name, dataType: config.dataType, categories: config.categories };
}

function configHash(config: Pick<ReviewScoreConfig, "name" | "dataType" | "categories">): string {
  return createHash("sha256").update(JSON.stringify(configCore(config))).digest("hex");
}

function sameConfig(local: ReviewScoreConfig, remote: RemoteScoreConfig): boolean {
  return !remote.isArchived && configHash(local) === configHash({
    name: remote.name,
    dataType: remote.dataType as ReviewScoreConfig["dataType"],
    categories: remote.categories ?? [],
  });
}

function sameIds(left: string[], right: string[]): boolean {
  return [...left].sort().join("\0") === [...right].sort().join("\0");
}

export function createLangfuseReviewQueueTransportFromEnv(
  env: Env = process.env,
  fetchImpl: FetchLike = fetch,
): ReviewQueueTransport | undefined {
  const publicKey = env.LANGFUSE_PUBLIC_KEY;
  const secretKey = env.LANGFUSE_SECRET_KEY;
  if (!publicKey || !secretKey) return undefined;
  return new LangfuseRestReviewQueueTransport({
    baseUrl: env.LANGFUSE_BASE_URL || "https://cloud.langfuse.com",
    publicKey,
    secretKey,
    fetchImpl,
  });
}

export class LangfuseRestReviewQueueTransport implements ReviewQueueTransport {
  private readonly authorization: string;
  private projectId?: string;
  private readonly queueItems = new Map<string, Map<string, RemoteQueueItem>>();

  constructor(private readonly options: {
    baseUrl: string;
    publicKey: string;
    secretKey: string;
    fetchImpl?: FetchLike;
    timeoutMs?: number;
    maxAttempts?: number;
    retryDelayMs?: number;
  }) {
    this.authorization = `Basic ${Buffer.from(`${options.publicKey}:${options.secretKey}`).toString("base64")}`;
  }

  async ensureScoreConfig(config: ReviewScoreConfig): Promise<{ id: string; contentHash: string }> {
    const find = async () => (await this.listAll<RemoteScoreConfig>("/api/public/score-configs"))
      .find((candidate) => candidate.name === config.name);
    let existing = await find();
    if (existing && !sameConfig(config, existing)) {
      throw new Error(`Langfuse score config ${config.name} exists with an incompatible schema`);
    }
    if (!existing) {
      try {
        existing = await this.request<RemoteScoreConfig>("/api/public/score-configs", {
          method: "POST",
          body: JSON.stringify({
            name: config.name,
            dataType: config.dataType,
            categories: config.categories,
            description: config.description,
          }),
        });
      } catch (error) {
        if (!(error instanceof LangfuseReviewQueueHttpError) || error.status !== 409) throw error;
        existing = await find();
      }
    }
    if (!existing || !sameConfig(config, existing)) {
      throw new Error(`Langfuse score config ${config.name} could not be established compatibly`);
    }
    return { id: existing.id, contentHash: configHash(config) };
  }

  async ensureQueue(name: string, scoreConfigIds: string[]): Promise<{ id: string }> {
    const find = async () => (await this.listAll<RemoteQueue>("/api/public/annotation-queues"))
      .find((candidate) => candidate.name === name);
    let queue = await find();
    if (queue && !sameIds(queue.scoreConfigIds, scoreConfigIds)) {
      throw new Error(`Langfuse annotation queue ${name} exists with incompatible score configs`);
    }
    if (!queue) {
      try {
        queue = await this.request<RemoteQueue>("/api/public/annotation-queues", {
          method: "POST",
          body: JSON.stringify({
            name,
            description: "Chamfer versioned semantic review queue",
            scoreConfigIds,
          }),
        });
      } catch (error) {
        if (!(error instanceof LangfuseReviewQueueHttpError) || error.status !== 409) throw error;
        queue = await find();
      }
    }
    if (!queue || !sameIds(queue.scoreConfigIds, scoreConfigIds)) {
      throw new Error(`Langfuse annotation queue ${name} could not be established compatibly`);
    }
    await this.ensureProjectId();
    return { id: queue.id };
  }

  async findQueueItem(queueId: string, objectId: string): Promise<{ id: string } | undefined> {
    let items = this.queueItems.get(queueId);
    if (!items) {
      const remote = await this.listAll<RemoteQueueItem>(
        `/api/public/annotation-queues/${encodeURIComponent(queueId)}/items`,
      );
      items = new Map(remote.map((item) => [item.objectId, item]));
      this.queueItems.set(queueId, items);
    }
    return items.get(objectId);
  }

  async addQueueItem(
    queueId: string,
    item: { objectId: string; objectType: "TRACE" | "OBSERVATION" },
  ): Promise<{ id: string }> {
    const created = await this.request<RemoteQueueItem>(
      `/api/public/annotation-queues/${encodeURIComponent(queueId)}/items`,
      { method: "POST", body: JSON.stringify(item) },
    );
    this.queueItems.get(queueId)?.set(created.objectId, created);
    return created;
  }

  reviewReference(queueId: string, itemId: string): string {
    if (!this.projectId) throw new Error("Langfuse project identity is unavailable");
    return `${this.options.baseUrl.replace(/\/$/, "")}/project/${encodeURIComponent(this.projectId)}`
      + `/annotation-queues/${encodeURIComponent(queueId)}/items/${encodeURIComponent(itemId)}`;
  }

  private async ensureProjectId(): Promise<string> {
    if (this.projectId) return this.projectId;
    const response = await this.request<{ data: Array<{ id: string }> }>("/api/public/projects");
    const projectId = response.data[0]?.id;
    if (!projectId) throw new Error("Langfuse API key has no project");
    this.projectId = projectId;
    return projectId;
  }

  private async listAll<T>(path: string): Promise<T[]> {
    const data: T[] = [];
    for (let page = 1; page <= 100; page += 1) {
      const separator = path.includes("?") ? "&" : "?";
      const response = await this.request<Page<T>>(`${path}${separator}page=${page}&limit=100`);
      data.push(...response.data);
      if (page >= response.meta.totalPages) return data;
    }
    throw new Error("Langfuse pagination exceeded the bounded review queue limit");
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const maxAttempts = this.options.maxAttempts ?? 4;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let response: Response;
      try {
        response = await (this.options.fetchImpl ?? fetch)(`${this.options.baseUrl.replace(/\/$/, "")}${path}`, {
          ...init,
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 5_000),
          headers: {
            authorization: this.authorization,
            accept: "application/json",
            ...(init.body ? { "content-type": "application/json" } : {}),
            ...init.headers,
          },
        });
      } catch {
        if (attempt >= maxAttempts) throw new Error("Langfuse review queue request failed");
        await this.retryDelay(attempt);
        continue;
      }
      if (response.ok) return await response.json() as T;
      if (!isRetryableStatus(response.status) || attempt >= maxAttempts) {
        throw new LangfuseReviewQueueHttpError(response.status);
      }
      await this.retryDelay(attempt, response.headers.get("retry-after"));
    }
    throw new Error("Langfuse review queue request exhausted retries");
  }

  private async retryDelay(attempt: number, retryAfter: string | null = null): Promise<void> {
    const retryAfterMs = retryAfter === null ? 0 : parseRetryAfterMs(retryAfter);
    const exponentialMs = (this.options.retryDelayMs ?? 500) * 2 ** (attempt - 1);
    const delayMs = Math.min(60_000, Math.max(retryAfterMs, exponentialMs));
    if (delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function parseRetryAfterMs(value: string): number {
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}
