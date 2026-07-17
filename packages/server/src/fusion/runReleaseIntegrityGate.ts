import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  REQUIRED_FAKE_INTEGRITY_TESTS,
  REQUIRED_LIVE_INTEGRITY_CHECKS,
  FUSION_INTEGRITY_FIXTURES,
  isStrictFusionLoopbackEndpoint,
  type FusionReleaseIntegrityReport,
} from "./integrityGate";
import { runFusionIntegrityProbe, type FusionIntegrityReport } from "./integrityProbe";

type Observation = { file: string; title: string; status: string };

const ROOT = resolve(import.meta.dirname, "../../../../");
const PLAYWRIGHT = resolve(ROOT, "node_modules/.bin/playwright");
const VITEST = resolve(ROOT, "node_modules/.bin/vitest");

const FAKE_SPECS = [
  "e2e/cad-environment-binding.spec.ts",
  "e2e/fusion-atomic-action.spec.ts",
  "e2e/fusion-image-001.spec.ts",
  "e2e/fusion-integrity-gate.spec.ts",
  "e2e/fusion-installed-api.spec.ts",
  "e2e/fusion-manual-reconciliation.spec.ts",
  "e2e/fusion-ownership.spec.ts",
  "e2e/fusion-readiness.spec.ts",
  "e2e/fusion-save.spec.ts",
  "e2e/fusion-security-privacy.spec.ts",
  "e2e/fusion-text-001.spec.ts",
  "e2e/fusion-text-002.spec.ts",
  "e2e/zzz-fusion-recovery.spec.ts",
];

const FAKE_CONTRACT: Record<(typeof REQUIRED_FAKE_INTEGRITY_TESTS)[number], Array<{ file: string; title: string }>> = {
  "cad-environment-binding": [{ file: "cad-environment-binding.spec.ts", title: "explicitly and permanently bound" }],
  "integrity-access": [{ file: "fusion-integrity-gate.spec.ts", title: "controlled tester sees the current integrity verdict" }],
  "readiness-states": [{ file: "fusion-readiness.spec.ts", title: "every fail-closed state" }],
  "document-ownership": [{ file: "fusion-ownership.spec.ts", title: "transfers ownership explicitly" }],
  "atomic-action": [{ file: "fusion-atomic-action.spec.ts", title: "one native Undo entry" }],
  "installed-api": [{ file: "fusion-installed-api.spec.ts", title: "installed API guidance" }],
  "manual-reconciliation": [{ file: "fusion-manual-reconciliation.spec.ts", title: "manual parameter edits reconcile" }],
  "explicit-save": [{ file: "fusion-save.spec.ts", title: "explicit Save promotes" }],
  "save-cancellation": [{ file: "fusion-save.spec.ts", title: "canceled explicit Save" }],
  "save-failure": [{ file: "fusion-save.spec.ts", title: "failed explicit Save" }],
  "security-privacy": [{ file: "fusion-security-privacy.spec.ts", title: "security and provider-evidence boundaries" }],
  "recovery-disconnect": [
    { file: "zzz-fusion-recovery.spec.ts", title: "timeout reconnects only for diagnosis" },
    { file: "zzz-fusion-recovery.spec.ts", title: "disconnect reconnects only for diagnosis" },
  ],
  "recovery-cancellation": [
    { file: "zzz-fusion-recovery.spec.ts", title: "cancellation stops the browser turn" },
    { file: "zzz-fusion-recovery.spec.ts", title: "cancellation during post-action inspection" },
  ],
  "recovery-rollback": [{ file: "zzz-fusion-recovery.spec.ts", title: "immediate verification failure is undone" }],
  "recovery-stale-request": [{ file: "zzz-fusion-recovery.spec.ts", title: "stale pre-execution request" }],
  "recovery-failed-undo": [{ file: "zzz-fusion-recovery.spec.ts", title: "failed Undo enters persistent hard recovery" }],
  "FUS-TEXT-001": [
    { file: "fusion-text-001.spec.ts", title: "completes through the production agent" },
    { file: "fusion-text-001.spec.ts", title: "forbidden outcomes remain failed or rolled back" },
  ],
  "FUS-IMAGE-001": [
    { file: "fusion-image-001.spec.ts", title: "completes through attachment" },
    { file: "fusion-image-001.spec.ts", title: "rejects reversed, wrong-face" },
    { file: "fusion-image-001.spec.ts", title: "rejects a completed sheet after a newer" },
  ],
  "FUS-TEXT-002": [
    { file: "fusion-text-002.spec.ts", title: "completes the industrial fixture" },
    { file: "fusion-text-002.spec.ts", title: "rejects broken industrial intent" },
  ],
};

const LIVE_FIXTURES = [
  { id: "FUS-TEXT-001", file: "src/fusion/text001Fixture.live.test.ts", env: "CHAMFER_LIVE_FUSION_TEXT_001" },
  { id: "FUS-IMAGE-001", file: "src/fusion/image001Fixture.live.test.ts", env: "CHAMFER_LIVE_FUSION_IMAGE_001" },
  { id: "FUS-TEXT-002", file: "src/fusion/text002Fixture.live.test.ts", env: "CHAMFER_LIVE_FUSION_TEXT_002" },
] as const;

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function run(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  return new Promise((resolveCode) => {
    const child = spawn(command, args, { cwd: ROOT, env, stdio: "inherit" });
    child.once("error", () => resolveCode(1));
    child.once("exit", (code) => resolveCode(code ?? 1));
  });
}

export function observationsFromPlaywright(value: unknown): Observation[] {
  const observations: Observation[] = [];
  const visit = (suite: unknown, inheritedFile = "") => {
    if (!suite || typeof suite !== "object") return;
    const item = suite as Record<string, unknown>;
    const file = typeof item.file === "string" ? basename(item.file) : inheritedFile;
    if (Array.isArray(item.specs)) for (const spec of item.specs) {
      if (!spec || typeof spec !== "object") continue;
      const record = spec as Record<string, unknown>;
      const title = typeof record.title === "string" ? record.title : "";
      const tests = Array.isArray(record.tests) ? record.tests : [];
      const statuses = tests.flatMap((test) => {
        if (!test || typeof test !== "object") return [];
        const results = (test as Record<string, unknown>).results;
        return Array.isArray(results) ? results.flatMap((result) =>
          result && typeof result === "object" && typeof (result as Record<string, unknown>).status === "string"
            ? [(result as Record<string, unknown>).status as string]
            : []) : [];
      });
      const status = statuses.length > 0 && statuses.every((candidate) => candidate === "passed") ? "passed"
        : statuses.some((candidate) => candidate === "skipped") ? "skipped" : "failed";
      observations.push({ file, title, status });
    }
    if (Array.isArray(item.suites)) for (const child of item.suites) visit(child, file);
  };
  const root = value && typeof value === "object" ? value as Record<string, unknown> : {};
  if (Array.isArray(root.suites)) for (const suite of root.suites) visit(suite);
  return observations;
}

export function fakeCoverageResults(observations: Observation[]) {
  return REQUIRED_FAKE_INTEGRITY_TESTS.map((id) => {
    const expected = FAKE_CONTRACT[id];
    const matches = expected.map((contract) => observations.find((observation) =>
      observation.file === contract.file && observation.title.includes(contract.title)));
    const status = matches.every((match) => match?.status === "passed") ? "passed"
      : matches.some((match) => match?.status === "skipped") ? "skipped" : "failed";
    return { id, status: status as "passed" | "failed" | "skipped" };
  });
}

async function filesUnder(path: string): Promise<string[]> {
  const info = await stat(path);
  if (info.isFile()) return [path];
  const files: string[] = [];
  for (const entry of await readdir(path)) files.push(...await filesUnder(join(path, entry)));
  return files.sort();
}

async function hashPaths(paths: string[], predicate: (path: string) => boolean = () => true): Promise<string> {
  const files = (await Promise.all(paths.map((path) => filesUnder(resolve(ROOT, path))))).flat().filter(predicate).sort();
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(relative(ROOT, file));
    hash.update("\0");
    hash.update(await readFile(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export async function hashReleaseArtifact(packagePath: string): Promise<string> {
  const packageRoot = resolve(ROOT, packagePath);
  const paths = ["package.json", "bin/chamfer.js", "dist/server.mjs", "dist/client"];
  const files = (await Promise.all(paths.map((path) => filesUnder(join(packageRoot, path))))).flat().sort();
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(relative(packageRoot, file).replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(await readFile(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function liveCheck(probe: FusionIntegrityReport | undefined, ids: string[]) {
  return ids.every((id) => probe?.checks.some((check) => check.id === id && check.passed));
}

async function main() {
  const artifactPath = argument("--artifact");
  const release = argument("--release");
  const outputArgument = argument("--out") ?? "fusion-release-integrity.json";
  const output = resolve(ROOT, outputArgument);
  if (!artifactPath || !release) throw new Error("Usage: fusion:gate --artifact <built-cli-package> --release <identity> [--out <report>] [--live --create-disposable]");
  const artifactSha256 = await hashReleaseArtifact(artifactPath);
  const gitCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  const trackedChanges = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
    cwd: ROOT, encoding: "utf8",
  }).trim();
  if (trackedChanges) throw new Error("Release integrity must run from a clean tracked worktree so the recorded Git commit names the tested code.");
  const temp = await mkdtemp(join(tmpdir(), "chamfer-fusion-gate-"));
  const fakeStartedAt = new Date().toISOString();
  const playwrightReport = join(temp, "playwright.json");
  const fakeExit = await run(PLAYWRIGHT, ["test", "-c", "e2e/playwright.config.ts", ...FAKE_SPECS, "--reporter=json", "--max-failures=1"], {
    ...process.env,
    CHAMFER_FAKE_LLM: "1",
    CHAMFER_DATA_DIR: join(temp, "data"),
    PLAYWRIGHT_JSON_OUTPUT_FILE: playwrightReport,
  });
  let observations: Observation[] = [];
  try { observations = observationsFromPlaywright(JSON.parse(await readFile(playwrightReport, "utf8"))); } catch { /* incomplete stays failed */ }
  const fakeTests = fakeCoverageResults(observations);
  const fakePassed = fakeExit === 0 && fakeTests.every((test) => test.status === "passed");
  const fakeFinishedAt = new Date().toISOString();

  const liveRequested = process.argv.includes("--live");
  const disposableDocumentAuthorized = process.argv.includes("--create-disposable");
  const endpoint = argument("--endpoint") ?? process.env.CHAMFER_FUSION_MCP_ENDPOINT ?? "http://127.0.0.1:27182/mcp";
  const liveStartedAt = new Date().toISOString();
  let probe: FusionIntegrityReport | undefined;
  const liveFixtureStatus = new Map<string, "passed" | "failed" | "unsupported">();
  if (fakePassed && liveRequested && disposableDocumentAuthorized && isStrictFusionLoopbackEndpoint(endpoint)) {
    probe = await runFusionIntegrityProbe({ endpoint, createDisposable: true });
    if (probe.verdict === "go") {
      for (const fixture of LIVE_FIXTURES) {
        const vitestReport = join(temp, `vitest-${fixture.id}.json`);
        const code = await run(VITEST, ["--run", fixture.file, "--reporter=json", `--outputFile=${vitestReport}`], {
          ...process.env,
          CHAMFER_FUSION_MCP_ENDPOINT: endpoint,
          [fixture.env]: "1",
        });
        let passed = false;
        try {
          const summary = JSON.parse(await readFile(vitestReport, "utf8")) as Record<string, unknown>;
          passed = code === 0 && summary.success === true && summary.numPassedTests === 1 && summary.numPendingTests === 0;
        } catch { /* a missing report is a failed fixture */ }
        liveFixtureStatus.set(fixture.id, passed ? "passed" : "failed");
        if (!passed) break;
      }
    }
    for (const fixture of LIVE_FIXTURES) if (!liveFixtureStatus.has(fixture.id)) liveFixtureStatus.set(fixture.id, "failed");
  } else {
    for (const fixture of LIVE_FIXTURES) liveFixtureStatus.set(fixture.id, "unsupported");
  }
  const probeContracts: Record<string, string[]> = {
    "handshake-compatibility": ["mcp-session", "raw-tool-schemas", "installed-api-documentation"],
    "document-identity": ["document-identity-stability", "unrelated-document-isolation"],
    "design-eligibility": ["design-eligibility"],
    "single-undo-atomicity": ["single-undo-atomicity"],
    "automatic-rollback": ["deliberate-immediate-verification", "deterministic-rollback"],
    "manual-edit-detection": ["manual-edit-detection"],
    "entity-ambiguity-handling": ["entity-ambiguity-handling"],
    "exact-camera-restoration": ["exact-camera-restoration"],
  };
  const liveChecks = REQUIRED_LIVE_INTEGRITY_CHECKS.map((id) => {
    if (liveFixtureStatus.has(id)) return { id, status: liveFixtureStatus.get(id)! };
    const passed = liveCheck(probe, probeContracts[id] ?? []);
    return { id, status: passed ? "passed" as const : liveRequested ? "failed" as const : "unsupported" as const };
  });
  const livePassed = probe?.verdict === "go" && liveChecks.every((check) => check.status === "passed");
  const liveFinishedAt = new Date().toISOString();
  const integrityFailures = [
    ...fakeTests.filter((test) => test.status !== "passed").map((test) => ({ code: `fake:${test.id}`, detail: `Required fake coverage is ${test.status}.` })),
    ...liveChecks.filter((check) => check.status === "failed").map((check) => ({ code: `live:${check.id}`, detail: "Required live coverage failed." })),
    ...(probe?.checks.filter((check) => !check.passed).map((check) => ({ code: `probe:${check.id}`, detail: check.detail })) ?? []),
  ];
  const limitations = liveRequested
    ? !fakePassed ? ["Live coverage was not run because the deterministic fake seam failed."]
      : !disposableDocumentAuthorized ? ["Live coverage was refused because disposable-document authority was not explicit."]
      : !isStrictFusionLoopbackEndpoint(endpoint) ? ["Live coverage was refused because the endpoint was not strict loopback."] : []
    : ["Live Fusion coverage was not run; normal-user promotion remains blocked."];
  const verdict = fakePassed && livePassed && integrityFailures.length === 0 && limitations.length === 0 ? "go" as const : "no-go" as const;
  const identityVersion = gitCommit.slice(0, 12);
  const report: FusionReleaseIntegrityReport = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    artifact: { sha256: artifactSha256, release, gitCommit },
    identities: {
      connector: { version: identityVersion, sha256: await hashPaths(["packages/server/src/fusion"], (path) => !path.includes(".test.") && !path.endsWith("runReleaseIntegrityGate.ts")) },
      policy: { version: identityVersion, sha256: await hashPaths(["packages/server/src/fusion/actionPolicy.ts"]) },
      skills: { version: identityVersion, sha256: await hashPaths(["packages/client/src/agent/fusionPrompt.ts", "packages/client/src/agent/fusion-skills"]) },
      fixtures: { version: identityVersion, sha256: await hashPaths(["packages/fusion-fixtures/src", ".scratch/fusion-connector/fixtures/FUS-IMAGE-001-reference.png"], (path) => !path.includes(".test.")) },
    },
    fake: { status: fakePassed ? "passed" : "failed", runner: "playwright", startedAt: fakeStartedAt, finishedAt: fakeFinishedAt, tests: fakeTests, fixtures: [...FUSION_INTEGRITY_FIXTURES] },
    live: {
      status: livePassed ? "passed" : liveRequested ? "failed" : "incomplete",
      runner: "vitest", startedAt: liveStartedAt, finishedAt: liveFinishedAt, endpoint,
      disposableDocumentAuthorized: liveRequested && disposableDocumentAuthorized,
      versions: { fusion: probe?.versions?.fusion ?? "", mcpProtocol: probe?.versions?.mcpProtocol ?? "", mcpServer: probe?.versions?.mcpServer ?? "" },
      checks: liveChecks, fixtures: LIVE_FIXTURES.map((fixture) => fixture.id),
    },
    integrityFailures,
    limitations,
    verdict,
  };
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  await rm(temp, { recursive: true, force: true });
  process.stdout.write(`${output}\n${verdict}\n`);
  if (verdict !== "go") process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
