import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  FusionEvaluationAttemptSchema,
  assertFusionEvaluationPrivacySafe,
  buildFusionEvaluationPlan,
  compareFusionCohorts,
  evaluateFusionAttempt,
  isUsableFusionAttemptArtifact,
  loadFusionEvaluationCorpus,
  sha256,
  type FusionEvaluationAttempt,
  type FusionEvaluationIdentity,
} from "./evaluation";
import {
  renderFusionCohortMarkdown,
  renderFusionComparisonMarkdown,
  renderFusionSuperiorityGateMarkdown,
  type FusionCohortArtifact,
} from "./evaluationArtifacts";
import { buildFusionReviewedScoresIdentity, evaluateFusionSuperiorityGate } from "./superiorityGate";
import { FusionReleaseIntegrityReportSchema, isStrictFusionLoopbackEndpoint } from "./integrityGate";

const ROOT = resolve(import.meta.dirname, "../../../../");
const PLAYWRIGHT = resolve(ROOT, "node_modules/.bin/playwright");
const DEFAULT_CORPUS = "evaluation/fusion/v1/corpus.json";
const DEFAULT_RELEASE_CORPUS = "evaluation/fusion/v1/release-corpus.json";

const CLI_OPTION_NAMES = ["corpus", "trials", "trial-start", "mode", "endpoint", "integrity-report",
  "disposable-document-id", "cases", "cohort", "out", "provider", "model", "fusion-version", "mcp-name",
  "mcp-version", "mcp-protocol", "input", "chamfer", "autodesk", "parent-cohorts", "metadata"] as const;
type CliOptions = Partial<Record<(typeof CLI_OPTION_NAMES)[number], string>>;

function parseCliOptions(args: string[]): CliOptions {
  const options = Object.fromEntries(CLI_OPTION_NAMES.map((name) => [name, { type: "string" as const }]));
  return parseArgs({ args, options, strict: true, allowPositionals: false }).values as CliOptions;
}

async function filesUnder(path: string): Promise<string[]> {
  const info = await stat(path);
  if (info.isFile()) return [path];
  const files: string[] = [];
  for (const entry of await readdir(path)) files.push(...await filesUnder(join(path, entry)));
  return files.sort();
}

async function hashPaths(paths: string[], include: (path: string) => boolean = () => true): Promise<string> {
  const files = (await Promise.all(paths.map((path) => filesUnder(resolve(ROOT, path))))).flat().filter(include).sort();
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(relative(ROOT, file).replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(await readFile(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function buildIdentity(
  corpusVersion: string,
  corpusSha256: string,
  executionMode: "scripted" | "live",
  options: CliOptions,
): Promise<FusionEvaluationIdentity> {
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: ROOT, encoding: "utf8" }).trim().length > 0;
  const version = `${commit.slice(0, 12)}${dirty ? "-dirty" : ""}`;
  const productRelease = (JSON.parse(await readFile(resolve(ROOT, "packages/cli/package.json"), "utf8")) as { version?: string }).version;
  if (!productRelease) throw new Error("Unable to resolve the Chamfer product release");
  const provider = executionMode === "scripted" ? "scripted" : options.provider ?? process.env.CHAMFER_PROVIDER;
  const model = executionMode === "scripted" ? "chamfer-fake-llm-v1" : options.model ?? process.env.CHAMFER_MODEL;
  if (!provider || !model) throw new Error("Live Fusion evaluation requires pinned --provider and --model values");
  const resolvedAgentConfiguration = {
    executionMode,
    provider,
    model,
    maxCadRuns: process.env.CHAMFER_MAX_CAD_RUNS ?? "product-default",
  };
  const sourceFile = (path: string) => !path.includes(".test.") && !path.endsWith("runEvaluation.ts") && !path.endsWith("evaluation.ts") && !path.endsWith("evaluationArtifacts.ts");
  return {
    product: { release: productRelease, gitCommit: commit, dirty },
    connector: { version, sha256: await hashPaths(["packages/server/src/fusion"], sourceFile) },
    agent: { version, sha256: await hashPaths(["packages/client/src/agent"], (path) => !path.includes(".test.")),
      configurationSha256: sha256(resolvedAgentConfiguration) },
    toolset: { version, sha256: await hashPaths(["packages/client/src/agent/tools"], (path) => !path.includes(".test.")) },
    model: { provider, model, configurationSha256: sha256({ provider, model }) },
    inferenceSettingsSha256: sha256({ provider, model }),
    prompt: { version, sha256: await hashPaths(["packages/client/src/agent/prompt.ts", "packages/client/src/agent/fusionPrompt.ts"]) },
    policy: { version, sha256: await hashPaths(["packages/server/src/fusion/actionPolicy.ts"]) },
    skills: { version, sha256: await hashPaths(["packages/client/src/agent/fusion-skills", "packages/client/src/agent/fusionPrompt.ts"]) },
    evaluator: { version: "fusion-typed-effects-v1", sha256: await hashPaths([
      "packages/server/src/fusion/evaluation.ts", "packages/server/src/fusion/evaluationArtifacts.ts",
      "packages/fusion-fixtures/src",
    ], (path) => !path.includes(".test.")) },
    fusion: { version: options["fusion-version"] ?? "2704.1.23" },
    mcp: {
      name: options["mcp-name"] ?? "Autodesk Fusion MCP",
      version: options["mcp-version"] ?? "1.0.0",
      protocol: options["mcp-protocol"] ?? "2025-11-25",
    },
    corpus: { version: corpusVersion, sha256: corpusSha256 },
    runner: { version: "fusion-browser-runner-v1", sha256: await hashPaths([
      "packages/server/src/fusion/evaluation.ts",
      "packages/server/src/fusion/evaluationArtifacts.ts",
      "packages/server/src/fusion/runEvaluation.ts",
      "e2e/fusion-evaluation.spec.ts",
      "e2e/playwright.config.ts",
    ]) },
    environment: { nodeVersion: process.version, platform: process.platform, arch: process.arch, browser: "playwright-chromium" },
    parentCohortIds: (options["parent-cohorts"] ?? "").split(",").map((value) => value.trim()).filter(Boolean),
  };
}

async function execute(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolveCode) => {
    const child = spawn(command, args, { cwd: ROOT, env, stdio: "inherit" });
    child.once("error", () => resolveCode(1));
    child.once("exit", (code) => resolveCode(code ?? 1));
  });
}

async function readAttemptEvidence(path: string): Promise<{ attempts: FusionEvaluationAttempt[]; failures: string[] }> {
  const info = await stat(path);
  const files = info.isDirectory() ? (await filesUnder(path)).filter((file) => file.endsWith(".json")) : [path];
  const attempts: FusionEvaluationAttempt[] = [];
  const failures: string[] = [];
  for (const file of files) {
    let value: unknown;
    try { value = JSON.parse(await readFile(file, "utf8")); } catch {
      failures.push(`Invalid attempt JSON: ${relative(ROOT, file)}`);
      continue;
    }
    const candidates = Array.isArray(value) ? value
      : value && typeof value === "object" && Array.isArray((value as { attempts?: unknown }).attempts)
        ? (value as { attempts: unknown[] }).attempts : [value];
    for (const candidate of candidates) {
      const parsed = FusionEvaluationAttemptSchema.safeParse(candidate);
      if (!parsed.success) failures.push(`Unpinned or malformed attempt in ${relative(ROOT, file)}: ${parsed.error.issues[0]?.message ?? "invalid schema"}`);
      else attempts.push(parsed.data);
    }
  }
  return { attempts, failures };
}

async function attemptFiles(path: string): Promise<FusionEvaluationAttempt[]> {
  const result = await readAttemptEvidence(path);
  if (result.failures.length > 0) throw new Error(result.failures[0]);
  return result.attempts;
}

function cohortArtifact(
  corpus: Awaited<ReturnType<typeof loadFusionEvaluationCorpus>>,
  attempts: FusionEvaluationAttempt[],
): FusionCohortArtifact {
  if (attempts.length === 0) throw new Error("The Fusion evaluation produced no valid pinned attempts");
  const cohortIds = new Set(attempts.map((attempt) => attempt.cohortId));
  const participants = new Set(attempts.map((attempt) => attempt.participant));
  const modes = new Set(attempts.map((attempt) => attempt.executionMode));
  const identities = new Set(attempts.map((attempt) => sha256(attempt.identity)));
  if (cohortIds.size !== 1 || participants.size !== 1 || modes.size !== 1 || identities.size !== 1) {
    throw new Error("A cohort artifact must contain one cohort, participant, execution mode, and pinned identity");
  }
  if (attempts.some((attempt) => attempt.identity.corpus.version !== corpus.version || attempt.identity.corpus.sha256 !== corpus.sha256)) {
    throw new Error("A cohort attempt does not identify the loaded corpus");
  }
  if (new Set(attempts.map((attempt) => attempt.attemptId)).size !== attempts.length ||
      new Set(attempts.map((attempt) => `${attempt.caseId}\0${attempt.caseVersion}\0${attempt.trial}`)).size !== attempts.length) {
    throw new Error("A cohort artifact cannot contain duplicate attempts or trials");
  }
  const byIdentity = new Map(corpus.cases.map((item) => [`${item.id}@${item.version}`, item]));
  return {
    cohortId: attempts[0]!.cohortId,
    participant: attempts[0]!.participant,
    executionMode: attempts[0]!.executionMode,
    corpusVersion: corpus.version,
    corpusSha256: corpus.sha256,
    identity: attempts[0]!.identity,
    privacyScan: "passed",
    attempts: attempts.map((attempt) => {
      const evaluationCase = byIdentity.get(`${attempt.caseId}@${attempt.caseVersion}`);
      if (!evaluationCase) throw new Error(`Attempt ${attempt.attemptId} references a case outside the pinned corpus`);
      const evaluated = evaluateFusionAttempt(evaluationCase, attempt);
      return {
        caseId: attempt.caseId,
        trial: attempt.trial,
        verdict: evaluated.verdict,
        eligibleForProficiency: evaluated.eligibleForProficiency,
        semanticReviewPending: evaluated.semanticReviewPending,
        failures: evaluated.failures,
        executionState: attempt.executionState,
        observedOutcome: attempt.observedOutcome,
        evidence: attempt.evidence,
        deterministic: attempt.deterministic,
        semantic: attempt.semantic,
        diagnostics: attempt.diagnostics,
      };
    }).sort((a, b) => a.caseId.localeCompare(b.caseId) || a.trial - b.trial),
  };
}

async function writeCohortArtifact(output: string, artifact: FusionCohortArtifact): Promise<void> {
  assertFusionEvaluationPrivacySafe(artifact);
  await writeFile(join(output, "cohort.json"), `${JSON.stringify(artifact, null, 2)}\n`);
  await writeFile(join(output, "cohort.md"), renderFusionCohortMarkdown(artifact));
}

async function runCohort(options: CliOptions): Promise<void> {
  const corpusPath = options.corpus ?? DEFAULT_CORPUS;
  const corpus = await loadFusionEvaluationCorpus(corpusPath, ROOT);
  const trials = Number(options.trials ?? "1");
  if (!Number.isInteger(trials) || trials < 1) throw new Error("--trials must be a positive integer");
  const trialStart = Number(options["trial-start"] ?? "1");
  if (!Number.isInteger(trialStart) || trialStart < 1) throw new Error("--trial-start must be a positive integer");
  if (options.mode !== undefined && options.mode !== "live" && options.mode !== "scripted") throw new Error("--mode must be live or scripted");
  const executionMode = options.mode === "live" ? "live" as const : "scripted" as const;
  const externalEndpoint = options.endpoint;
  const integrityReport = options["integrity-report"];
  const disposableDocumentId = options["disposable-document-id"];
  if (externalEndpoint && (executionMode !== "live" || !isStrictFusionLoopbackEndpoint(externalEndpoint) || !integrityReport || !disposableDocumentId)) {
    throw new Error("External Fusion evaluation requires live mode, a strict loopback --endpoint, --integrity-report, and --disposable-document-id");
  }
  const selectedCases = options.cases ?? corpus.cases.map((item) => item.id).join(",");
  const selected = new Set(selectedCases.split(",").map((value) => value.trim()).filter(Boolean));
  if (selected.size === 0 || [...selected].some((id) => !corpus.cases.some((item) => item.id === id))) throw new Error("--cases contains an unknown Fusion evaluation case");
  if (externalEndpoint && (trials !== 1 || selected.size !== 1)) {
    throw new Error("External Fusion evaluation runs one case and one trial at a time so a fresh disposable document can be prepared before every attempt; reuse --cohort and advance --trial-start");
  }
  const cohortId = options.cohort ?? `chamfer-${executionMode}-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
  const output = resolve(ROOT, options.out ?? `docs/internal/fusion-evaluation/${cohortId}`);
  await mkdir(output, { recursive: true });
  const identity = await buildIdentity(corpus.version, corpus.sha256, executionMode, options);
  if (externalEndpoint && integrityReport) {
    const report = FusionReleaseIntegrityReportSchema.parse(JSON.parse(await readFile(resolve(ROOT, integrityReport), "utf8")));
    if (report.verdict !== "go" || report.live.endpoint !== externalEndpoint ||
        report.live.versions.fusion !== identity.fusion.version ||
        report.live.versions.mcpProtocol !== identity.mcp.protocol ||
        report.live.versions.mcpServer !== identity.mcp.version ||
        report.artifact.gitCommit !== identity.product.gitCommit) {
      throw new Error("External Fusion integrity report does not match the pinned endpoint, build, Fusion, or MCP identity");
    }
  }
  const identityPath = join(output, "identity.json");
  await writeFile(identityPath, `${JSON.stringify(identity, null, 2)}\n`);
  const code = await execute(PLAYWRIGHT, ["test", "-c", "e2e/playwright.config.ts", "e2e/fusion-evaluation.spec.ts"], {
    ...process.env,
    CHAMFER_PROVIDER: executionMode === "live" ? identity.model.provider : process.env.CHAMFER_PROVIDER,
    CHAMFER_MODEL: executionMode === "live" ? identity.model.model : process.env.CHAMFER_MODEL,
    CHAMFER_FAKE_LLM: executionMode === "scripted" ? "1" : undefined,
    CHAMFER_DATA_DIR: join(output, "runtime"),
    CHAMFER_FUSION_EVAL_OUTPUT: join(output, "attempts"),
    CHAMFER_FUSION_EVAL_IDENTITY: identityPath,
    CHAMFER_FUSION_EVAL_CORPUS: corpusPath,
    CHAMFER_FUSION_EVAL_CASES: [...selected].join(","),
    CHAMFER_FUSION_EVAL_TRIALS: String(trials),
    CHAMFER_FUSION_EVAL_TRIAL_START: String(trialStart),
    CHAMFER_FUSION_EVAL_MODE: executionMode,
    CHAMFER_FUSION_EVAL_COHORT: cohortId,
    CHAMFER_FUSION_EVAL_EXTERNAL_ENDPOINT: externalEndpoint,
    CHAMFER_FUSION_EVAL_DISPOSABLE_DOCUMENT_ID: disposableDocumentId,
    CHAMFER_FUSION_INTEGRITY_REPORT: integrityReport ? resolve(ROOT, integrityReport) : process.env.CHAMFER_FUSION_INTEGRITY_REPORT,
  });
  const attempts = await attemptFiles(join(output, "attempts"));
  const artifact = cohortArtifact(corpus, attempts);
  await writeCohortArtifact(output, artifact);
  process.stdout.write(`${output}\n`);
  if (code !== 0 || artifact.attempts.some((attempt) => !isUsableFusionAttemptArtifact(attempt))) process.exitCode = 1;
}

async function ingestAutodesk(options: CliOptions): Promise<void> {
  const input = options.input;
  if (!input) throw new Error("ingest-autodesk requires --input <attempt-json-or-directory>");
  const corpus = await loadFusionEvaluationCorpus(options.corpus ?? DEFAULT_CORPUS, ROOT);
  const attempts = await attemptFiles(resolve(ROOT, input));
  if (attempts.length === 0 || attempts.some((attempt) => attempt.participant !== "autodesk-assistant" || attempt.executionMode !== "ingested")) {
    throw new Error("Autodesk ingestion accepts only pinned autodesk-assistant attempts in ingested mode");
  }
  const artifact = cohortArtifact(corpus, attempts);
  const output = resolve(ROOT, options.out ?? `docs/internal/fusion-evaluation/${artifact.cohortId}`);
  await mkdir(join(output, "attempts"), { recursive: true });
  for (const attempt of attempts) {
    assertFusionEvaluationPrivacySafe(attempt);
    await writeFile(join(output, "attempts", `autodesk-${attempt.caseId}-${attempt.trial}.json`), `${JSON.stringify(attempt, null, 2)}\n`);
  }
  await writeCohortArtifact(output, artifact);
  process.stdout.write(`${output}\n`);
}

async function compare(options: CliOptions): Promise<void> {
  const chamferPath = options.chamfer;
  const autodeskPath = options.autodesk;
  const trials = Number(options.trials);
  if (!chamferPath || !autodeskPath || !Number.isInteger(trials) || trials < 1) {
    throw new Error("compare requires --chamfer <path> --autodesk <path> --trials <positive integer>");
  }
  const corpus = await loadFusionEvaluationCorpus(options.corpus ?? DEFAULT_CORPUS, ROOT);
  const comparison = compareFusionCohorts(corpus.cases,
    await attemptFiles(resolve(ROOT, chamferPath)), await attemptFiles(resolve(ROOT, autodeskPath)), trials);
  assertFusionEvaluationPrivacySafe(comparison);
  const output = resolve(ROOT, options.out ?? `docs/internal/fusion-evaluation/comparison-${Date.now()}`);
  await mkdir(output, { recursive: true });
  await writeFile(join(output, "comparison.json"), `${JSON.stringify(comparison, null, 2)}\n`);
  await writeFile(join(output, "comparison.md"), renderFusionComparisonMarkdown(comparison));
  process.stdout.write(`${output}\n${comparison.verdict}\n`);
  if (comparison.verdict !== "ready") process.exitCode = 1;
}

async function superiorityGate(options: CliOptions): Promise<void> {
  const chamferPath = options.chamfer;
  const autodeskPath = options.autodesk;
  const metadataPath = options.metadata;
  const trials = Number(options.trials);
  if (!chamferPath || !autodeskPath || !metadataPath || !Number.isInteger(trials) || trials < 1) {
    throw new Error("gate requires --chamfer <path> --autodesk <path> --metadata <json> --trials <positive integer>");
  }
  if (options.corpus && options.corpus !== DEFAULT_RELEASE_CORPUS) {
    throw new Error(`gate uses only the authoritative corpus at ${DEFAULT_RELEASE_CORPUS}`);
  }
  const corpus = await loadFusionEvaluationCorpus(DEFAULT_RELEASE_CORPUS, ROOT);
  const inputFailures: string[] = [];
  const readGateAttempts = async (label: string, path: string) => {
    try {
      const evidence = await readAttemptEvidence(resolve(ROOT, path));
      inputFailures.push(...evidence.failures);
      return evidence.attempts;
    } catch {
      inputFailures.push(`${label} evidence could not be read from the configured path`);
      return [];
    }
  };
  const [chamfer, autodesk] = await Promise.all([
    readGateAttempts("Chamfer", chamferPath),
    readGateAttempts("Autodesk", autodeskPath),
  ]);
  let metadata: unknown;
  try { metadata = JSON.parse(await readFile(resolve(ROOT, metadataPath), "utf8")); } catch {
    inputFailures.push("Gate metadata could not be read from the configured path");
  }
  const result = evaluateFusionSuperiorityGate(corpus, chamfer, autodesk, trials, metadata, inputFailures);
  assertFusionEvaluationPrivacySafe(result);
  const output = resolve(ROOT, options.out ?? `docs/internal/fusion-evaluation/superiority-gate-${Date.now()}`);
  await mkdir(output, { recursive: true });
  await writeFile(join(output, "superiority-gate.json"), `${JSON.stringify(result, null, 2)}\n`);
  await writeFile(join(output, "superiority-gate.md"), renderFusionSuperiorityGateMarkdown(result));
  process.stdout.write(`${output}\n${result.verdict}\n`);
  if (!result.promotionAllowed) process.exitCode = 1;
}

async function reviewScoresIdentity(options: CliOptions): Promise<void> {
  if (!options.chamfer || !options.autodesk) {
    throw new Error("review-identity requires --chamfer <path> --autodesk <path>");
  }
  const attempts = [
    ...await attemptFiles(resolve(ROOT, options.chamfer)),
    ...await attemptFiles(resolve(ROOT, options.autodesk)),
  ];
  process.stdout.write(`${buildFusionReviewedScoresIdentity(attempts)}\n`);
}

async function plan(options: CliOptions): Promise<void> {
  const corpus = await loadFusionEvaluationCorpus(options.corpus ?? DEFAULT_CORPUS, ROOT);
  const trials = Number(options.trials ?? "5");
  const selected = options.cases?.split(",").map((value) => value.trim()).filter(Boolean);
  const artifact = buildFusionEvaluationPlan(corpus, trials, selected);
  assertFusionEvaluationPrivacySafe(artifact);
  const output = resolve(ROOT, options.out ?? `docs/internal/fusion-evaluation/plan-${Date.now()}`);
  await mkdir(output, { recursive: true });
  await writeFile(join(output, "plan.json"), `${JSON.stringify(artifact, null, 2)}\n`);
  const rows = artifact.cases.map((evaluationCase) =>
    `| ${evaluationCase.caseId}@${evaluationCase.caseVersion} | ${evaluationCase.trialNumbers.join(", ")} | ${evaluationCase.deterministicEffectCount} | ${evaluationCase.faultInjection?.kind ?? "none"} | ${evaluationCase.attackVectors.join(", ") || "none"} |`);
  await writeFile(join(output, "plan.md"), [
    "# Fusion repeated-trial plan", "", `Corpus: ${artifact.corpusVersion} (${artifact.corpusSha256})`,
    `Trials per case: ${artifact.requiredTrials}`, "", "| Case | Trials | Typed effects | Fault | Attacks |",
    "| --- | ---: | ---: | --- | --- |", ...rows, "",
    `Paired schedule: ${artifact.schedule.length} runs, ordered Chamfer then Autodesk Assistant within every case/trial pair.`, "",
  ].join("\n"));
  process.stdout.write(`${output}\n`);
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "run";
  const options = parseCliOptions(process.argv.slice(3));
  if (command === "run") return runCohort(options);
  if (command === "ingest-autodesk") return ingestAutodesk(options);
  if (command === "compare") return compare(options);
  if (command === "gate") return superiorityGate(options);
  if (command === "review-identity") return reviewScoresIdentity(options);
  if (command === "plan") return plan(options);
  throw new Error("Usage: fusion:evaluate -- <run|plan|ingest-autodesk|compare|review-identity|gate> [options]");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
