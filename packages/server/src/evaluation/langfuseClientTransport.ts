import { createHash } from "node:crypto";
import { LangfuseClient } from "@langfuse/client";
import { LangfuseAPIError, LangfuseAPITimeoutError } from "@langfuse/core";
import {
  LangfuseTransportError,
  type DatasetItemPayload,
  type DatasetPayload,
  type DatasetRunItemPayload,
  type LangfuseSyncTransport,
  type RemoteDataset,
  type RemoteDatasetItem,
  type RemoteDatasetRun,
  type ScorePayload,
  type TracePayload,
} from "./langfuseExperimentSync";

type Env = Record<string, string | undefined>;

function requestOptions(signal?: AbortSignal) {
  return { maxRetries: 0, timeoutInSeconds: 5, abortSignal: signal } as const;
}

export function createLangfuseSyncTransportFromEnv(
  env: Env = process.env,
): LangfuseSyncTransport | undefined {
  const publicKey = env.LANGFUSE_PUBLIC_KEY;
  const secretKey = env.LANGFUSE_SECRET_KEY;
  if (!publicKey || !secretKey) return undefined;
  const baseUrl = env.LANGFUSE_BASE_URL || "https://cloud.langfuse.com";
  const client = new LangfuseClient({ publicKey, secretKey, baseUrl, timeout: 5 });
  return new LangfuseClientTransport(client, baseUrl);
}

export class LangfuseClientTransport implements LangfuseSyncTransport {
  private projectId?: string;

  constructor(
    private readonly client: LangfuseClient,
    private readonly baseUrl: string,
  ) {}

  async getDataset(name: string, signal?: AbortSignal): Promise<RemoteDataset | undefined> {
    return this.optional(() => this.client.api.datasets.get(name, requestOptions(signal)));
  }

  async upsertDataset(payload: DatasetPayload, signal?: AbortSignal): Promise<RemoteDataset> {
    try {
      return await this.call(() => this.client.api.datasets.create(payload, requestOptions(signal)));
    } catch (error) {
      if (error instanceof LangfuseTransportError && error.cause instanceof LangfuseAPIError
        && error.cause.statusCode === 409) {
        const existing = await this.getDataset(payload.name, signal);
        if (existing) return existing;
      }
      throw error;
    }
  }

  async getDatasetItem(id: string, signal?: AbortSignal): Promise<RemoteDatasetItem | undefined> {
    return this.optional(() => this.client.api.datasetItems.get(id, requestOptions(signal)));
  }

  async upsertDatasetItem(payload: DatasetItemPayload, signal?: AbortSignal): Promise<RemoteDatasetItem> {
    return this.call(() => this.client.api.datasetItems.create(payload, requestOptions(signal)));
  }

  async getDatasetRun(datasetName: string, runName: string, signal?: AbortSignal): Promise<RemoteDatasetRun | undefined> {
    const run = await this.optional(
      () => this.client.api.datasets.getRun(datasetName, runName, requestOptions(signal)),
    );
    if (!run) return undefined;
    return {
      id: run.id,
      name: run.name,
      metadata: run.metadata,
      items: run.datasetRunItems.map(({ datasetItemId, traceId }) => ({ datasetItemId, traceId })),
    };
  }

  async getTrace(id: string, signal?: AbortSignal) {
    const trace = await this.optional(
      () => this.client.api.trace.get(id, { fields: "core,io" }, requestOptions(signal)),
    );
    return trace ? { id: trace.id, metadata: trace.metadata } : undefined;
  }

  async upsertTrace(payload: TracePayload, signal?: AbortSignal): Promise<void> {
    await this.ingest({
      type: "trace-create",
      id: eventId("trace", payload.id),
      timestamp: new Date().toISOString(),
      body: payload,
    }, signal);
  }

  async upsertDatasetRunItem(payload: DatasetRunItemPayload, signal?: AbortSignal) {
    return this.call(() => this.client.api.datasetRunItems.create({
      runName: payload.runName,
      runDescription: payload.runDescription,
      metadata: payload.metadata,
      datasetItemId: payload.datasetItemId,
      traceId: payload.traceId,
    }, requestOptions(signal)));
  }

  async upsertScore(payload: ScorePayload, signal?: AbortSignal): Promise<void> {
    await this.ingest({
      type: "score-create",
      id: eventId("score", payload.id),
      timestamp: new Date().toISOString(),
      body: {
        id: payload.id,
        traceId: payload.traceId,
        observationId: payload.observationId,
        name: payload.name,
        value: payload.value,
        dataType: payload.dataType,
        comment: payload.comment,
        metadata: payload.metadata,
        environment: payload.environment ?? "evaluation",
      },
    }, signal);
  }

  async comparisonUrls(datasetId: string, datasetRunId: string, signal?: AbortSignal) {
    const projectId = await this.getProjectId(signal);
    const projectUrl = `${this.baseUrl.replace(/\/$/, "")}/project/${encodeURIComponent(projectId)}`;
    const datasetUrl = `${projectUrl}/datasets/${encodeURIComponent(datasetId)}`;
    return {
      dataset: datasetUrl,
      cohort: `${datasetUrl}/runs/${encodeURIComponent(datasetRunId)}`,
    };
  }

  async flush(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    // This transport awaits direct ingestion for every trace and score, so it never creates SDK-buffered telemetry.
  }

  async shutdown(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    // LangfuseClient creates no timer or network work until its score queue is used, which this transport never does.
  }

  private async getProjectId(signal?: AbortSignal): Promise<string> {
    if (this.projectId) return this.projectId;
    const projects = await this.call(() => this.client.api.projects.get(requestOptions(signal)));
    const projectId = projects.data[0]?.id;
    if (!projectId) throw new LangfuseTransportError("Langfuse API key has no project", false);
    this.projectId = projectId;
    return projectId;
  }

  private async ingest(
    event: Parameters<LangfuseClient["api"]["ingestion"]["batch"]>[0]["batch"][number],
    signal?: AbortSignal,
  ) {
    const response = await this.call(
      () => this.client.api.ingestion.batch({ batch: [event] }, requestOptions(signal)),
    );
    if (response.errors.length > 0) {
      const retryable = response.errors.some(({ status }) => isRetryableStatus(status));
      throw new LangfuseTransportError("Langfuse rejected an ingestion event", retryable);
    }
  }

  private async optional<T>(fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await this.call(fn);
    } catch (error) {
      if (error instanceof LangfuseTransportError && error.cause instanceof LangfuseAPIError
        && error.cause.statusCode === 404) return undefined;
      throw error;
    }
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof LangfuseTransportError) throw error;
      throw translateError(error);
    }
  }
}

function translateError(error: unknown): LangfuseTransportError {
  if (error instanceof LangfuseAPITimeoutError) {
    return new LangfuseTransportError("Langfuse request timed out", true, { cause: error });
  }
  if (error instanceof LangfuseAPIError) {
    const status = error.statusCode;
    return new LangfuseTransportError(
      status ? `Langfuse request failed (HTTP ${status})` : "Langfuse request failed",
      isRetryableStatus(status),
      { cause: error },
    );
  }
  return new LangfuseTransportError("Langfuse network request failed", true, { cause: error });
}

function isRetryableStatus(status: number | undefined): boolean {
  return status === 408 || status === 429 || (status !== undefined && status >= 500);
}

function eventId(kind: "trace" | "score", stableId: string): string {
  return createHash("sha256").update(`chamfer-langfuse-${kind}\0${stableId}`).digest("hex").slice(0, 32);
}
