import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../db";
import { loadDotenv } from "../envConfig";
import { createLangfuseReviewQueueTransportFromEnv } from "./langfuseReviewQueueTransport";
import { syncOnlineReviewInventory } from "./onlineReviewQueueSync";
import { syncOfflineReviewCohort } from "./offlineReviewQueueSync";
import type { OfflineExperimentCohort } from "./langfuseExperimentSync";

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

export async function runOnlineReviewQueueSyncCommand(input: {
  dbPath: string;
  reportPath: string;
  queueName?: string;
  limit?: number;
}): Promise<void> {
  const transport = createLangfuseReviewQueueTransportFromEnv();
  const db = openDb(input.dbPath);
  try {
    const result = transport
      ? await syncOnlineReviewInventory({
          db,
          transport,
          queueName: input.queueName,
          limit: input.limit,
        })
      : { status: "unavailable" as const, reason: "missing_credentials", items: [] };
    await mkdir(dirname(input.reportPath), { recursive: true });
    await writeFile(input.reportPath, `${JSON.stringify({
      schemaVersion: 1,
      synchronizedAt: new Date().toISOString(),
      result,
    }, null, 2)}\n`, { mode: 0o600 });
    await chmod(input.reportPath, 0o600);
    console.log(`Online review queue synchronization: ${result.status}`);
    console.log(`Local synchronization report: ${input.reportPath}`);
    for (const item of result.items) console.log(`Review item: ${item.reference}`);
    if (result.status !== "synced") process.exitCode = 1;
  } finally {
    db.close();
  }
}

export async function runOfflineReviewQueueSyncCommand(input: {
  cohortPath: string;
  reportPath: string;
  queueName?: string;
}): Promise<void> {
  const transport = createLangfuseReviewQueueTransportFromEnv();
  const cohort = JSON.parse(await readFile(input.cohortPath, "utf8")) as OfflineExperimentCohort;
  const result = transport
    ? await syncOfflineReviewCohort({ cohort, transport, queueName: input.queueName })
    : { status: "unavailable" as const, reason: "missing_credentials", items: [] };
  await mkdir(dirname(input.reportPath), { recursive: true });
  await writeFile(input.reportPath, `${JSON.stringify({
    schemaVersion: 1,
    synchronizedAt: new Date().toISOString(),
    result,
  }, null, 2)}\n`, { mode: 0o600 });
  await chmod(input.reportPath, 0o600);
  console.log(`Offline review queue synchronization: ${result.status}`);
  console.log(`Local synchronization report: ${input.reportPath}`);
  for (const item of result.items) console.log(`Review item: ${item.reference}`);
  if (result.status !== "synced") process.exitCode = 1;
}

async function main(): Promise<void> {
  loadDotenv();
  const dbPath = argument("db");
  const cohortPath = argument("cohort");
  if (Boolean(dbPath) === Boolean(cohortPath)) {
    throw new Error("Usage: exactly one of --db=<chamfer.db> or --cohort=<offline-cohort.json>");
  }
  const reportPath = resolve(argument("report") ?? "docs/internal/evaluations/online-review-queue.json");
  const repoRoot = resolve(import.meta.dirname, "../../../..");
  const insideRepo = relative(repoRoot, reportPath);
  if (!insideRepo.startsWith("..") && !isAbsolute(insideRepo)) {
    const insidePrivate = relative(resolve(repoRoot, "docs/internal"), reportPath);
    if (insidePrivate.startsWith("..") || isAbsolute(insidePrivate)) {
      throw new Error("Review queue reports inside the public repository must be under docs/internal");
    }
  }
  const rawLimit = argument("limit");
  const limit = rawLimit === undefined ? undefined : Number(rawLimit);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error("limit must be a positive integer");
  }
  if (dbPath) {
    await runOnlineReviewQueueSyncCommand({
      dbPath: resolve(dbPath),
      reportPath,
      queueName: argument("queue"),
      limit,
    });
  } else {
    await runOfflineReviewQueueSyncCommand({
      cohortPath: resolve(cohortPath!),
      reportPath,
      queueName: argument("queue"),
    });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
