import { readFileSync } from "node:fs";
import { z } from "zod";

const ResultStatusSchema = z.enum(["passed", "failed", "skipped", "unsupported"]);

export const REQUIRED_FAKE_INTEGRITY_TESTS = [
  "cad-environment-binding",
  "integrity-access",
  "readiness-states",
  "document-ownership",
  "atomic-action",
  "installed-api",
  "manual-reconciliation",
  "explicit-save",
  "save-cancellation",
  "save-failure",
  "security-privacy",
  "recovery-disconnect",
  "recovery-cancellation",
  "recovery-rollback",
  "recovery-stale-request",
  "recovery-failed-undo",
  "FUS-TEXT-001",
  "FUS-IMAGE-001",
  "FUS-TEXT-002",
] as const;

export const REQUIRED_LIVE_INTEGRITY_CHECKS = [
  "handshake-compatibility",
  "document-identity",
  "design-eligibility",
  "single-undo-atomicity",
  "automatic-rollback",
  "manual-edit-detection",
  "entity-ambiguity-handling",
  "exact-camera-restoration",
  "FUS-TEXT-001",
  "FUS-IMAGE-001",
  "FUS-TEXT-002",
] as const;

export const FUSION_INTEGRITY_FIXTURES = ["FUS-TEXT-001", "FUS-IMAGE-001", "FUS-TEXT-002"] as const;

const IntegrityResultSchema = z.object({
  id: z.string().min(1),
  status: ResultStatusSchema,
  detail: z.string().optional(),
}).strict();
const IntegrityIdentitySchema = z.object({ version: z.string().min(1), sha256: z.string() }).strict();
const IntegrityRunSchema = z.object({
  status: z.enum(["passed", "failed", "incomplete"]),
  runner: z.enum(["playwright", "vitest"]),
  startedAt: z.string(),
  finishedAt: z.string(),
  fixtures: z.array(z.string()),
}).strict();

export const FusionReleaseIntegrityReportSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string(),
  artifact: z.object({ sha256: z.string(), release: z.string().min(1), gitCommit: z.string() }).strict(),
  identities: z.object({
    connector: IntegrityIdentitySchema,
    policy: IntegrityIdentitySchema,
    skills: IntegrityIdentitySchema,
    fixtures: IntegrityIdentitySchema,
  }).strict(),
  fake: IntegrityRunSchema.extend({ runner: z.literal("playwright"), tests: z.array(IntegrityResultSchema) }).strict(),
  live: IntegrityRunSchema.extend({
    runner: z.literal("vitest"),
    endpoint: z.string(),
    disposableDocumentAuthorized: z.boolean(),
    versions: z.object({ fusion: z.string(), mcpProtocol: z.string(), mcpServer: z.string() }).strict(),
    checks: z.array(IntegrityResultSchema),
  }).strict(),
  integrityFailures: z.array(z.object({ code: z.string().min(1), detail: z.string().min(1) }).strict()),
  limitations: z.array(z.string()),
  verdict: z.enum(["go", "no-go"]),
}).strict();

export type FusionReleaseIntegrityReport = z.infer<typeof FusionReleaseIntegrityReportSchema>;
type IntegrityRun = FusionReleaseIntegrityReport["fake"] | FusionReleaseIntegrityReport["live"];
type IntegrityResult = FusionReleaseIntegrityReport["fake"]["tests"][number];

export interface FusionIntegrityAccess {
  enabled: boolean;
  access: "hidden" | "experimental" | "released";
  verdict: "go" | "no-go";
  limitations: string[];
}

const HASH = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const LOOPBACK = /^http:\/\/127\.0\.0\.1:\d{1,5}\/mcp$/;

export function isStrictFusionLoopbackEndpoint(endpoint: string): boolean {
  return LOOPBACK.test(endpoint);
}

function validDate(value: string): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function runCoverageFailures(
  run: IntegrityRun,
  results: IntegrityResult[],
  required: readonly string[],
  label: string,
): string[] {
  const failures: string[] = [];
  if (run.status !== "passed") failures.push(`${label} seam did not pass.`);
  if (!validDate(run.startedAt) || !validDate(run.finishedAt) || Date.parse(run.finishedAt) < Date.parse(run.startedAt)) {
    failures.push(`${label} seam timestamps are invalid.`);
  }
  for (const fixture of FUSION_INTEGRITY_FIXTURES) {
    if (!run.fixtures.includes(fixture)) failures.push(`${label} seam is missing fixture ${fixture}.`);
  }
  const byId = new Map(results.map((result) => [result.id, result.status]));
  for (const id of required) {
    if (byId.get(id) !== "passed") failures.push(`${label} coverage ${id} is missing or did not pass.`);
  }
  for (const result of results) {
    if (result.status !== "passed") failures.push(`${label} result ${result.id} is ${result.status}.`);
  }
  return failures;
}

export function fusionIntegrityReportFailures(
  report: FusionReleaseIntegrityReport | undefined,
  currentArtifactSha256: string | undefined,
): string[] {
  if (!report) return ["No Fusion release-integrity report is configured."];
  const failures: string[] = [];
  if (report.schemaVersion !== 1) failures.push("The Fusion release-integrity report version is unsupported.");
  if (!validDate(report.generatedAt)) failures.push("The Fusion release-integrity report date is invalid.");
  if (!currentArtifactSha256 || !HASH.test(currentArtifactSha256) || report.artifact.sha256 !== currentArtifactSha256) {
    failures.push("The report does not identify the current release artifact.");
  }
  if (!HASH.test(report.artifact.sha256) || !COMMIT.test(report.artifact.gitCommit) || !report.artifact.release) {
    failures.push("The release artifact identity is incomplete.");
  }
  for (const [name, identity] of Object.entries(report.identities)) {
    if (!identity.version || !HASH.test(identity.sha256)) failures.push(`The ${name} identity is incomplete.`);
  }
  failures.push(...runCoverageFailures(report.fake, report.fake.tests, REQUIRED_FAKE_INTEGRITY_TESTS, "Fake"));
  failures.push(...runCoverageFailures(report.live, report.live.checks, REQUIRED_LIVE_INTEGRITY_CHECKS, "Live"));
  if (!report.live.disposableDocumentAuthorized) failures.push("Live coverage did not record disposable-document authority.");
  if (!isStrictFusionLoopbackEndpoint(report.live.endpoint)) failures.push("Live coverage did not use the strict loopback endpoint.");
  if (!report.live.versions.fusion || !report.live.versions.mcpProtocol || !report.live.versions.mcpServer) {
    failures.push("Live Fusion and MCP identities are incomplete.");
  }
  for (const failure of report.integrityFailures) failures.push(`${failure.code}: ${failure.detail}`);
  if (report.limitations.length > 0) failures.push(...report.limitations);
  if (report.verdict !== "go") failures.push("The report verdict is no-go.");
  return [...new Set(failures)];
}

export function evaluateFusionIntegrityAccess(
  report: FusionReleaseIntegrityReport | undefined,
  currentArtifactSha256: string | undefined,
  experimental: boolean,
): FusionIntegrityAccess {
  let limitations: string[];
  try {
    limitations = fusionIntegrityReportFailures(report, currentArtifactSha256);
  } catch {
    limitations = ["The Fusion release-integrity report is malformed."];
  }
  const released = limitations.length === 0;
  if (released) {
    return {
      enabled: true,
      access: experimental ? "experimental" : "released",
      verdict: "go",
      limitations: [],
    };
  }
  return {
    enabled: experimental,
    access: experimental ? "experimental" : "hidden",
    verdict: "no-go",
    limitations,
  };
}

export function fusionIntegrityAccessFromEnv(
  env: Record<string, string | undefined> = process.env,
): FusionIntegrityAccess {
  let report: FusionReleaseIntegrityReport | undefined;
  const path = env.CHAMFER_FUSION_RELEASE_INTEGRITY_REPORT;
  if (path) {
    try {
      const parsed = FusionReleaseIntegrityReportSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
      report = parsed.success ? parsed.data : undefined;
    } catch {
      report = undefined;
    }
  }
  return evaluateFusionIntegrityAccess(
    report,
    env.CHAMFER_RELEASE_ARTIFACT_SHA256,
    env.CHAMFER_EXPERIMENTAL_FUSION === "1",
  );
}
