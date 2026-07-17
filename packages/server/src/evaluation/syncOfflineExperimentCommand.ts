import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDotenv } from "../envConfig";
import { createLangfuseSyncTransportFromEnv } from "./langfuseClientTransport";
import {
  syncOfflineExperiment,
  type LangfuseSyncResult,
  type LangfuseSyncTransport,
  type OfflineExperimentCohort,
} from "./langfuseExperimentSync";

type Env = Record<string, string | undefined>;

export interface OfflineExperimentSyncReport {
  schemaVersion: 1;
  cohortId: string;
  localAuthority: true;
  synchronizedAt: string;
  result: LangfuseSyncResult;
}

export async function runOfflineExperimentSyncCommand(input: {
  cohortPath: string;
  reportPath: string;
  env?: Env;
  transport?: LangfuseSyncTransport;
}): Promise<OfflineExperimentSyncReport> {
  const cohort = parseCohort(JSON.parse(await readFile(input.cohortPath, "utf8")));
  const transport = input.transport ?? createLangfuseSyncTransportFromEnv(input.env);
  const result = await syncOfflineExperiment(cohort, { transport });
  const report: OfflineExperimentSyncReport = {
    schemaVersion: 1,
    cohortId: cohort.cohortId,
    localAuthority: true,
    synchronizedAt: new Date().toISOString(),
    result,
  };
  await mkdir(dirname(input.reportPath), { recursive: true });
  await writeFile(input.reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  return report;
}

function parseCohort(value: unknown): OfflineExperimentCohort {
  if (!value || typeof value !== "object") throw new Error("Offline cohort must be a JSON object");
  const cohort = value as Partial<OfflineExperimentCohort>;
  if (typeof cohort.cohortId !== "string" || !cohort.cohortId) throw new Error("Offline cohort needs a cohortId");
  if (typeof cohort.datasetName !== "string" || !cohort.datasetName) {
    throw new Error("Offline cohort needs a datasetName");
  }
  if (!Array.isArray(cohort.cases) || cohort.cases.length === 0) {
    throw new Error("Offline cohort needs at least one case");
  }
  return value as OfflineExperimentCohort;
}

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function validateLocalReportPath(repoRoot: string, reportPath: string): void {
  const absolute = resolve(reportPath);
  const insideRepo = relative(repoRoot, absolute);
  if (insideRepo.startsWith("..") || isAbsolute(insideRepo)) return;
  const privateRoot = resolve(repoRoot, "docs/internal");
  const insidePrivateRoot = relative(privateRoot, absolute);
  if (insidePrivateRoot.startsWith("..") || isAbsolute(insidePrivateRoot)) {
    throw new Error("Langfuse sync reports inside the public repository must be written under docs/internal");
  }
}

async function main(): Promise<void> {
  loadDotenv();
  const cohortPath = argument("cohort");
  if (!cohortPath) throw new Error("Usage: --cohort=<offline-cohort.json> [--report=<private-report.json>]");
  const repoRoot = resolve(import.meta.dirname, "../../../..");
  const reportPath = argument("report")
    ?? resolve(repoRoot, "docs/internal/evaluations", `langfuse-sync-${Date.now()}.json`);
  validateLocalReportPath(repoRoot, reportPath);
  const report = await runOfflineExperimentSyncCommand({ cohortPath: resolve(cohortPath), reportPath: resolve(reportPath) });
  console.log(`Langfuse synchronization: ${report.result.status}`);
  console.log(`Local synchronization report: ${resolve(reportPath)}`);
  if (report.result.status === "synced") console.log(`Langfuse comparison: ${report.result.references.cohort}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
