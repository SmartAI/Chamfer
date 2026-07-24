import { createHash } from "node:crypto";
import { isAgentConfigurationIdentity, type AgentConfigurationIdentity } from "@chamfer/shared";

export type ScoreDataType = "NUMERIC" | "CATEGORICAL" | "BOOLEAN" | "TEXT";

export interface ExperimentIdentities {
  corpus: string;
  agentConfiguration: AgentConfigurationIdentity;
  commit: string;
  model: string;
  evaluator: string;
  rubric: string;
  runner: string;
  repetition: string;
  parentCohort?: string;
}

export interface OfflineMeasurement {
  name: string;
  value: number | string;
  dataType?: ScoreDataType;
  comment?: string;
  metadata?: Record<string, unknown>;
}

export interface OfflineExperimentCase {
  caseId: string;
  caseVersion: string;
  repetition: { index: number; hash: string };
  input: unknown;
  expectedOutput?: unknown;
  output: unknown;
  taskOutcome: string;
  measurements: {
    integrity: OfflineMeasurement[];
    proficiency: OfflineMeasurement[];
    reliability: OfflineMeasurement[];
    efficiency: OfflineMeasurement[];
    diagnostic: OfflineMeasurement[];
  };
}

export interface OfflineExperimentCohort {
  datasetName: string;
  cohortId: string;
  release: string;
  evaluationMode: string;
  modality: string;
  complexity: string;
  category: string;
  purpose: string;
  gating: string;
  identities: ExperimentIdentities;
  cases: OfflineExperimentCase[];
}

interface SyncMetadata {
  schemaVersion: 1;
  contentHash: string;
}

export interface RemoteDataset {
  id: string;
  name: string;
  metadata?: unknown;
}

export interface RemoteDatasetItem {
  id: string;
  datasetId: string;
  metadata?: unknown;
}

export interface RemoteDatasetRun {
  id: string;
  name: string;
  metadata?: unknown;
  items: Array<{ datasetItemId: string; traceId: string }>;
}

export interface RemoteTrace {
  id: string;
  metadata?: unknown;
}

export interface DatasetPayload {
  name: string;
  description: string;
  metadata: Record<string, unknown> & { sync: SyncMetadata };
}

export interface DatasetItemPayload {
  id: string;
  datasetName: string;
  input: unknown;
  expectedOutput?: unknown;
  metadata: Record<string, unknown> & { sync: SyncMetadata };
}

export interface TracePayload {
  id: string;
  name: string;
  input: unknown;
  output: unknown;
  release: string;
  version: string;
  environment: string;
  tags: string[];
  metadata: Record<string, unknown> & { sync: SyncMetadata };
}

export interface DatasetRunItemPayload {
  runName: string;
  runDescription: string;
  datasetItemId: string;
  traceId: string;
  metadata: Record<string, unknown> & { sync: SyncMetadata };
}

export interface ScorePayload {
  id: string;
  traceId: string;
  observationId?: string;
  name: string;
  value: number | string;
  dataType: ScoreDataType;
  comment?: string;
  metadata?: Record<string, unknown>;
  environment?: string;
}

export interface LangfuseSyncTransport {
  getDataset(name: string, signal?: AbortSignal): Promise<RemoteDataset | undefined>;
  upsertDataset(payload: DatasetPayload, signal?: AbortSignal): Promise<RemoteDataset>;
  getDatasetItem(id: string, signal?: AbortSignal): Promise<RemoteDatasetItem | undefined>;
  upsertDatasetItem(payload: DatasetItemPayload, signal?: AbortSignal): Promise<RemoteDatasetItem>;
  getDatasetRun(datasetName: string, runName: string, signal?: AbortSignal): Promise<RemoteDatasetRun | undefined>;
  getTrace(id: string, signal?: AbortSignal): Promise<RemoteTrace | undefined>;
  upsertTrace(payload: TracePayload, signal?: AbortSignal): Promise<void>;
  upsertDatasetRunItem(payload: DatasetRunItemPayload, signal?: AbortSignal): Promise<{
    id: string;
    datasetRunId: string;
    datasetItemId: string;
    traceId: string;
  }>;
  upsertScore(payload: ScorePayload, signal?: AbortSignal): Promise<void>;
  comparisonUrls(datasetId: string, datasetRunId: string, signal?: AbortSignal): Promise<{
    dataset: string;
    cohort: string;
  }>;
  flush(signal?: AbortSignal): Promise<void>;
  shutdown(signal?: AbortSignal): Promise<void>;
}

export type LangfuseSyncResult =
  | {
      status: "synced";
      datasetId: string;
      datasetRunId: string;
      references: { dataset: string; cohort: string };
    }
  | { status: "skipped"; reason: "missing_credentials" }
  | { status: "unavailable"; reason: string };

export interface SyncOfflineExperimentOptions {
  transport?: LangfuseSyncTransport;
  retryDelayMs?: number;
  maxAttempts?: number;
  operationTimeoutMs?: number;
  shutdownTimeoutMs?: number;
}

export class LangfuseSyncConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LangfuseSyncConflictError";
  }
}

export class LangfuseTransportError extends Error {
  constructor(message: string, readonly retryable: boolean, options?: ErrorOptions) {
    super(message, options);
    this.name = "LangfuseTransportError";
  }
}

export async function syncOfflineExperiment(
  cohort: OfflineExperimentCohort,
  options: SyncOfflineExperimentOptions,
): Promise<LangfuseSyncResult> {
  const configuration = cohort.identities.agentConfiguration;
  if (!isAgentConfigurationIdentity(configuration)) {
    throw new Error("Experiment sync requires an artifact-derived agent configuration identity");
  }
  if (!options.transport) return { status: "skipped", reason: "missing_credentials" };
  if (cohort.cases.length === 0) throw new Error("Cannot synchronize an empty offline cohort");
  const transport = options.transport;
  const request = <T>(operation: string, fn: (signal: AbortSignal) => Promise<T>) => retry(operation, fn, options);
  const runName = `chamfer-cohort-${digest(cohort.cohortId)}`;
  const datasetHash = contentHash({ datasetName: cohort.datasetName, corpus: cohort.identities.corpus });
  const cohortHash = contentHash(cohort);
  const dimensions = {
    release: cohort.release,
    evaluationMode: cohort.evaluationMode,
    modality: cohort.modality,
    complexity: cohort.complexity,
    category: cohort.category,
    purpose: cohort.purpose,
    gating: cohort.gating,
  };
  const tags = [
    `release:${dimensions.release}`,
    `evaluation-mode:${dimensions.evaluationMode}`,
    `modality:${dimensions.modality}`,
    `complexity:${dimensions.complexity}`,
    `category:${dimensions.category}`,
    `purpose:${dimensions.purpose}`,
    `gating:${dimensions.gating}`,
  ];
  const runMetadata = {
    ...dimensions,
    tags,
    identities: cohort.identities,
    cohortId: cohort.cohortId,
    sync: syncMetadata(cohortHash),
  };

  try {
    const datasetPayload: DatasetPayload = {
      name: cohort.datasetName,
      description: "Chamfer canonical offline evaluation cases. Local cases and verdicts remain authoritative.",
      metadata: { corpusId: cohort.identities.corpus, sync: syncMetadata(datasetHash) },
    };
    const cases = cohort.cases.map((item) => {
      const itemHash = contentHash({
        caseId: item.caseId,
        caseVersion: item.caseVersion,
        repetition: item.repetition,
        input: item.input,
        expectedOutput: item.expectedOutput,
      });
      const itemId = `chamfer-case-${digest(`${item.caseId}\0${item.caseVersion}\0${item.repetition.hash}`)}`;
      const traceId = offlineExperimentTraceId(
        cohort.cohortId,
        item.caseId,
        item.caseVersion,
        item.repetition.hash,
      );
      const itemPayload: DatasetItemPayload = {
        id: itemId,
        datasetName: cohort.datasetName,
        input: item.input,
        expectedOutput: item.expectedOutput,
        metadata: {
          caseId: item.caseId,
          caseVersion: item.caseVersion,
          repetition: item.repetition,
          corpusId: cohort.identities.corpus,
          sync: syncMetadata(itemHash),
        },
      };
      const traceHash = contentHash({ cohortHash, itemHash, output: item.output });
      const tracePayload: TracePayload = {
        id: traceId,
        name: "chamfer.offline-evaluation",
        input: item.input,
        output: item.output,
        release: cohort.release,
        version: configuration.identityHash,
        environment: "evaluation",
        tags,
        metadata: {
          case: { id: item.caseId, version: item.caseVersion },
          repetition: item.repetition,
          identities: cohort.identities,
          cohortId: cohort.cohortId,
          sync: syncMetadata(traceHash),
        },
      };
      return { item, itemHash, itemId, traceId, traceHash, itemPayload, tracePayload };
    });

    const existingDataset = await request("get dataset", (signal) => transport.getDataset(cohort.datasetName, signal));
    if (existingDataset) assertCompatible("dataset", existingDataset.metadata, datasetHash);
    const existingItems = new Map<string, RemoteDatasetItem>();
    for (const entry of cases) {
      const existing = await request("get dataset item", (signal) => transport.getDatasetItem(entry.itemId, signal));
      if (existing) {
        assertCompatible(`dataset item ${entry.item.caseId}@${entry.item.caseVersion}`, existing.metadata, entry.itemHash);
      }
      if (existing && (!existingDataset || existing.datasetId !== existingDataset.id)) {
        throw new LangfuseSyncConflictError(
          `Dataset item ${entry.item.caseId}@${entry.item.caseVersion} belongs to another hosted dataset`,
        );
      }
      if (existing) existingItems.set(entry.itemId, existing);
      const existingTrace = await request("get trace", (signal) => transport.getTrace(entry.traceId, signal));
      if (existingTrace) assertCompatible(`trace ${entry.traceId}`, existingTrace.metadata, entry.traceHash);
    }
    const existingRun = await request(
      "get dataset run",
      (signal) => transport.getDatasetRun(cohort.datasetName, runName, signal),
    );
    if (existingRun) assertCompatible(`cohort ${cohort.cohortId}`, existingRun.metadata, cohortHash);
    const expectedTraceIds = new Map(cases.map(({ itemId, traceId }) => [itemId, traceId]));
    for (const existing of existingRun?.items ?? []) {
      if (expectedTraceIds.get(existing.datasetItemId) !== existing.traceId) {
        throw new LangfuseSyncConflictError(`Hosted cohort ${cohort.cohortId} contains a conflicting run item`);
      }
    }

    const dataset = existingDataset ?? await request(
      "upsert dataset",
      (signal) => transport.upsertDataset(datasetPayload, signal),
    );
    assertCompatible("dataset", dataset.metadata, datasetHash);
    let datasetRunId: string | undefined;

    for (const { item, itemId, traceId, itemPayload, tracePayload } of cases) {
      if (!existingItems.has(itemId)) {
        await request("upsert dataset item", (signal) => transport.upsertDatasetItem(itemPayload, signal));
      }
      const completedRunItem = existingRun?.items.find((candidate) => candidate.datasetItemId === itemId);
      if (completedRunItem) {
        datasetRunId = existingRun?.id;
        continue;
      }
      await request("upsert trace", (signal) => transport.upsertTrace(tracePayload, signal));
      for (const score of scoresFor(item)) {
        const scorePayload: ScorePayload = {
          ...score,
          id: digest(
            `${cohort.cohortId}\0${item.caseId}\0${item.caseVersion}\0${item.repetition.hash}\0${score.name}`,
          ).slice(0, 32),
          traceId,
          metadata: { ...score.metadata, repetition: item.repetition },
        };
        await request("upsert score", (signal) => transport.upsertScore(scorePayload, signal));
      }
      const runItemPayload: DatasetRunItemPayload = {
        runName,
        runDescription: `Chamfer offline evaluation cohort ${cohort.cohortId}`,
        datasetItemId: itemId,
        traceId,
        metadata: {
          ...runMetadata,
          case: { id: item.caseId, version: item.caseVersion },
          repetition: item.repetition,
        },
      };
      const runItem = await request(
        "upsert dataset run item",
        (signal) => transport.upsertDatasetRunItem(runItemPayload, signal),
      );
      datasetRunId ??= runItem.datasetRunId;
    }

    datasetRunId ??= existingRun?.id;
    if (!datasetRunId) throw new Error("Langfuse did not return a dataset run identity");
    const references = await request(
      "build comparison URLs",
      (signal) => transport.comparisonUrls(dataset.id, datasetRunId, signal),
    );
    return { status: "synced", datasetId: dataset.id, datasetRunId, references };
  } catch (error) {
    if (error instanceof LangfuseTransportError) {
      return { status: "unavailable", reason: error.message };
    }
    throw error;
  } finally {
    const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 1_000;
    await settleWithin((signal) => transport.flush(signal), shutdownTimeoutMs);
    await settleWithin((signal) => transport.shutdown(signal), shutdownTimeoutMs);
  }
}

export function offlineExperimentTraceId(
  cohortId: string,
  caseId: string,
  caseVersion: string,
  repetitionIdentity: string,
): string {
  return digest(`${cohortId}\0${caseId}\0${caseVersion}\0${repetitionIdentity}`).slice(0, 32);
}

async function retry<T>(
  operation: string,
  fn: (signal: AbortSignal) => Promise<T>,
  options: Pick<SyncOfflineExperimentOptions, "maxAttempts" | "operationTimeoutMs" | "retryDelayMs">,
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await withinTimeout(fn, options.operationTimeoutMs ?? 5_000, operation);
    } catch (error) {
      if (!(error instanceof LangfuseTransportError) || !error.retryable || attempt >= maxAttempts) throw error;
      const delayMs = (options.retryDelayMs ?? 100) * 2 ** (attempt - 1);
      if (delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error(`Unreachable retry state for ${operation}`);
}

async function withinTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  operation: string,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => fn(controller.signal)),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => {
            controller.abort(new Error(`${operation} timed out`));
            reject(new LangfuseTransportError(`${operation} timed out`, true));
          },
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function settleWithin(fn: (signal: AbortSignal) => Promise<void>, timeoutMs: number): Promise<void> {
  try {
    await withinTimeout(fn, timeoutMs, "Langfuse shutdown");
  } catch {
    // Synchronization is optional and must never make local command completion hang or fail.
  }
}

function assertCompatible(label: string, metadata: unknown, expectedHash: string): void {
  const sync = metadata && typeof metadata === "object"
    ? (metadata as { sync?: { schemaVersion?: unknown; contentHash?: unknown } }).sync
    : undefined;
  if (sync?.schemaVersion !== 1 || sync.contentHash !== expectedHash) {
    throw new LangfuseSyncConflictError(`Stable ${label} identity refers to different hosted content`);
  }
}

function scoresFor(item: OfflineExperimentCase): Array<Omit<ScorePayload, "id" | "traceId">> {
  const scores: Array<Omit<ScorePayload, "id" | "traceId">> = [
    { name: "task_outcome", value: item.taskOutcome, dataType: "CATEGORICAL" },
  ];
  for (const family of ["integrity", "proficiency", "reliability", "efficiency", "diagnostic"] as const) {
    for (const measurement of item.measurements[family]) {
      scores.push({
        name: `${family}.${measurement.name}`,
        value: measurement.value,
        dataType: measurement.dataType ?? (typeof measurement.value === "number" ? "NUMERIC" : "CATEGORICAL"),
        comment: measurement.comment,
        metadata: measurement.metadata,
      });
    }
  }
  return scores;
}

function syncMetadata(hash: string): SyncMetadata {
  return { schemaVersion: 1, contentHash: hash };
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function contentHash(value: unknown): string {
  return digest(JSON.stringify(canonicalize(value)));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}
