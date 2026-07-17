import { chromium } from "playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { arch, platform } from "node:os";
import { basename, resolve } from "node:path";
import { runBrowserCase } from "./browserCase";
import { hashFiles, gitIdentity } from "./fingerprint";
import { createEvaluationIdentities, sha256Identity, type EvaluationIdentities } from "./identity";
import {
  parseEvaluationResult,
  renderEvaluationMarkdown,
  serializeEvaluationResult,
  type EvaluationResult,
} from "./result";
import { loadEvaluationCase, type EvaluationCase } from "./schema";
import { startFreshStack } from "./stack";
import { scanPrivacy, type PrivacyScan } from "./privacy";
import { calculateCohortVerdict, renderCohortVerdict, type CohortVerdict } from "./verdict";
import { buildAttemptSchedule, loadResumableResult, type AttemptScheduleEntry } from "./cohort";
import { assertExpectedProductCommit, assertSupportedNodeVersion, resolveEvaluationRoots } from "./runtime";
import { validatePrivateArtifactOutput } from "./artifactPaths";
import { buildOfflineExperimentCohort } from "./offlineCohort";

const EVALUATOR_VERSION = 1;
const RUNNER_VERSION = 1;

async function runtimeInputs(implementationRoot: string, productRoot: string, browserVersion: string) {
  const [
    git,
    packageJson,
    promptHash,
    skillHash,
    policyHash,
    toolsetHash,
    productBuildHash,
    evaluatorHash,
    rubricHash,
    runnerHash,
  ] =
    await Promise.all([
      gitIdentity(productRoot),
      readFile(resolve(productRoot, "packages/cli/package.json"), "utf8")
        .then((value) => JSON.parse(value) as { version: string }),
      hashFiles(productRoot, ["packages/client/src/agent/prompt.ts"]),
      hashFiles(productRoot, ["packages/client/src/agent/build123dSkill.ts", "packages/client/src/agent/skills"]),
      hashFiles(productRoot, [
        "packages/client/src/agent/session.ts",
        "packages/client/src/agent/contextPolicy.ts",
        "packages/client/src/agent/compaction.ts",
        "packages/client/src/agent/retryStream.ts",
      ]),
      hashFiles(productRoot, ["packages/client/src/agent/tools"]),
      hashFiles(productRoot, [
        "package-lock.json",
        "packages/shared/src",
        "packages/server/src",
        "packages/client/src",
        "packages/client/public/py",
      ]),
      hashFiles(implementationRoot, ["packages/client/eval/evaluate.ts"]),
      hashFiles(implementationRoot, ["packages/client/eval/rubric.ts"]),
      hashFiles(implementationRoot, [
        "packages/client/eval/artifactPaths.ts",
        "packages/client/eval/browserCase.ts",
        "packages/client/eval/calibration.ts",
        "packages/client/eval/cohort.ts",
        "packages/client/eval/evaluate.ts",
        "packages/client/eval/fingerprint.ts",
        "packages/client/eval/identity.ts",
        "packages/client/eval/lifecycleMeasurements.ts",
        "packages/client/eval/offlineCohort.ts",
        "packages/client/eval/paired.ts",
        "packages/client/eval/privacy.ts",
        "packages/client/eval/result.ts",
        "packages/client/eval/rubric.ts",
        "packages/client/eval/runtime.ts",
        "packages/client/eval/runner.ts",
        "packages/client/eval/schema.ts",
        "packages/client/eval/stack.ts",
        "packages/client/eval/verdict.ts",
      ]),
    ]);
  return {
    git,
    release: packageJson.version,
    promptHash,
    skillHash,
    policyHash,
    toolsetHash,
    productBuildHash,
    evaluatorHash,
    rubricHash,
    runnerHash,
    environment: {
      node: process.versions.node,
      browser: `chromium-${browserVersion}`,
      operatingSystem: platform(),
      architecture: arch(),
      productBuildHash,
    },
  };
}

function identitiesForCase(input: {
  corpusCases: EvaluationCase[];
  evaluationCase: EvaluationCase;
  repetition: number;
  seed: number;
  depth: "scripted" | "targeted" | "release";
  model: { id: string; provider: string };
  runtime: Awaited<ReturnType<typeof runtimeInputs>>;
}): EvaluationIdentities {
  return createEvaluationIdentities({
    corpus: { id: "agent-evaluation-tracer", version: 1, cases: input.corpusCases },
    evaluationCase: input.evaluationCase,
    agentConfiguration: {
      productRelease: input.runtime.release,
      gitCommit: input.runtime.git.commit,
      dirty: input.runtime.git.dirty,
      promptHash: input.runtime.promptHash,
      skillHash: input.runtime.skillHash,
      policyHash: input.runtime.policyHash,
      toolsetHash: input.runtime.toolsetHash,
      provider: input.model.provider,
      model: input.model.id,
      inferenceSettings: { thinkingLevel: "off", transport: "auto", toolExecution: "parallel" },
    },
    evaluatorDefinitions: input.evaluationCase.evaluatorRefs.map((reference) => ({
      ...reference,
      sourceHash: sha256Identity({ evaluatorHash: input.runtime.evaluatorHash, id: reference.id }),
    })),
    rubricDefinitions: input.evaluationCase.rubricRefs.map((reference) => ({
      ...reference,
      sourceHash: sha256Identity({ rubricHash: input.runtime.rubricHash, id: reference.id, version: reference.version }),
    })),
    runner: { version: RUNNER_VERSION, sourceHash: input.runtime.runnerHash },
    environment: input.runtime.environment,
    repetition: { index: input.repetition, seed: input.seed, depth: input.depth },
  });
}

function infrastructureFailure(input: {
  identities: EvaluationIdentities;
  startedAt: string;
  startedMs: number;
  error: unknown;
  evaluationCase: EvaluationCase;
  depth: "scripted" | "targeted" | "release";
}): EvaluationResult {
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  return parseEvaluationResult({
    schemaVersion: 1,
    identities: input.identities,
    evidenceClass: input.depth === "scripted" ? "infrastructure" : "proficiency",
    execution: {
      state: "failed",
      startedAt: input.startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - input.startedMs,
      error: message,
    },
    outcome: { kind: "infrastructure-failure", expectedMatch: false, explanation: message },
    evidence: [],
    measurements: {
      cadRuns: 0,
      modelCalls: 0,
      toolCalls: 0,
      toolErrors: 0,
      searches: 0,
      skillLoads: 0,
      retries: 0,
      compactions: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      providerCost: 0,
    },
    scores: input.evaluationCase.evaluatorRefs.map((reference) => ({
      id: reference.id,
      evaluatorVersion: reference.version,
      status: "unavailable",
      required: reference.required,
      explanation: "Case execution did not produce evaluator evidence.",
      evidenceIds: [],
    })),
    proficiency: {
      included: false,
      exclusionReason: input.depth === "scripted"
        ? "Scripted execution is infrastructure evidence."
        : "Infrastructure failures are excluded from agent proficiency denominators.",
    },
    integrity: { violations: [] },
  });
}

async function writeResult(outputDir: string, result: EvaluationResult): Promise<{
  source: string;
  json: string;
  markdownSource: string;
  markdown: string;
}> {
  const prefix = `${result.identities.case.id}-v${result.identities.case.version}-r${result.identities.repetition.index}`;
  const json = serializeEvaluationResult(result);
  const markdown = renderEvaluationMarkdown(result);
  await Promise.all([
    writeFile(resolve(outputDir, `${prefix}.json`), json),
    writeFile(resolve(outputDir, `${prefix}.md`), markdown),
  ]);
  return { source: `${prefix}.json`, json, markdownSource: `${prefix}.md`, markdown };
}

function resultPath(outputDir: string, identities: EvaluationIdentities): string {
  const prefix = `${identities.case.id}-v${identities.case.version}-r${identities.repetition.index}`;
  return resolve(outputDir, `${prefix}.json`);
}

export interface EvaluationRun {
  results: EvaluationResult[];
  privacy: PrivacyScan;
  verdict: CohortVerdict;
}

export async function writeRunSummaries(
  outputDir: string,
  privacy: PrivacyScan,
  verdict: CohortVerdict,
): Promise<void> {
  await Promise.all([
    writeFile(resolve(outputDir, "privacy-scan.json"), `${JSON.stringify(privacy, null, 2)}\n`),
    writeFile(resolve(outputDir, "cohort-verdict.json"), `${JSON.stringify(verdict, null, 2)}\n`),
    writeFile(resolve(outputDir, "cohort-verdict.md"), renderCohortVerdict(verdict)),
  ]);
}

export async function runEvaluation(options: {
  repoRoot: string;
  casePaths: string[];
  outputDir: string;
  clientPort: number;
  apiPort: number;
  depth: "scripted" | "targeted" | "release";
  repetitions?: number;
  seed?: number;
  productRoot?: string;
  expectedProductCommit?: string;
  attemptSchedule?: AttemptScheduleEntry[];
}): Promise<EvaluationRun> {
  assertSupportedNodeVersion(process.versions.node);
  const roots = resolveEvaluationRoots(options);
  validatePrivateArtifactOutput(roots.implementationRoot, options.outputDir);
  const rawCases = await Promise.all(options.casePaths.map(async (path) => ({
    source: basename(path),
    content: await readFile(path, "utf8"),
  })));
  const preflightPrivacy = scanPrivacy(rawCases);
  const cases = await Promise.all(options.casePaths.map(loadEvaluationCase));
  const caseKeys = cases.map((evaluationCase) => `${evaluationCase.id}@${evaluationCase.version}`);
  if (new Set(caseKeys).size !== caseKeys.length) throw new Error("Evaluation cohort contains duplicate case identity");
  await mkdir(options.outputDir, { recursive: true });
  const repetitions = options.repetitions ?? (options.depth === "release" ? 3 : 1);
  if (!Number.isInteger(repetitions) || repetitions < 1) throw new Error("Repetitions must be a positive integer");
  if (options.depth === "release" && repetitions < 3) {
    throw new Error("Release evaluation requires at least three repetitions per case");
  }
  const seed = options.seed ?? 1;
  const schedule = options.attemptSchedule ?? buildAttemptSchedule(cases, repetitions, seed);
  if (schedule.length === 0) throw new Error("Evaluation schedule must contain at least one attempt");
  const availableCases = new Set(cases.map((evaluationCase) => `${evaluationCase.id}@${evaluationCase.version}`));
  for (const attempt of schedule) {
    if (!availableCases.has(`${attempt.caseId}@${attempt.caseVersion}`)) {
      throw new Error(`Evaluation schedule references unavailable case ${attempt.caseId}@${attempt.caseVersion}`);
    }
    if (!Number.isInteger(attempt.repetition) || attempt.repetition < 1) {
      throw new Error("Evaluation schedule repetitions must be positive integers");
    }
  }
  const requiredAttempts = schedule.map((attempt) => ({
    caseId: attempt.caseId,
    caseVersion: attempt.caseVersion,
    repetition: attempt.repetition,
  }));
  if (preflightPrivacy.status === "failed") {
    const verdict = calculateCohortVerdict({ results: [], requiredAttempts, privacy: preflightPrivacy });
    await writeRunSummaries(options.outputDir, preflightPrivacy, verdict);
    return { results: [], privacy: preflightPrivacy, verdict };
  }
  const dataDir = resolve(options.outputDir, "raw/data");
  await mkdir(dataDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  let stack: Awaited<ReturnType<typeof startFreshStack>> | undefined;
  const results: EvaluationResult[] = [];
  const generated: Array<{ source: string; content: string }> = [];
  try {
    const runtime = await runtimeInputs(roots.implementationRoot, roots.productRoot, browser.version());
    assertExpectedProductCommit(runtime.git.commit, options.expectedProductCommit);
    stack = await startFreshStack({
      repoRoot: roots.productRoot,
      dataDir,
      clientPort: options.clientPort,
      apiPort: options.apiPort,
      fakeModel: options.depth === "scripted",
    });
    const caseMap = new Map(cases.map((evaluationCase) => [
      `${evaluationCase.id}@${evaluationCase.version}`,
      evaluationCase,
    ]));
    for (const attempt of schedule) {
      const evaluationCase = caseMap.get(`${attempt.caseId}@${attempt.caseVersion}`);
      if (!evaluationCase) throw new Error(`Scheduled case ${attempt.caseId}@${attempt.caseVersion} is unavailable`);
      const identities = identitiesForCase({
        corpusCases: cases,
        evaluationCase,
        repetition: attempt.repetition,
        seed,
        depth: options.depth,
        model: stack.model,
        runtime,
      });
      const resumed = await loadResumableResult(resultPath(options.outputDir, identities), identities);
      if (resumed) {
        results.push(resumed);
        const artifact = await writeResult(options.outputDir, resumed);
        generated.push(
          { source: artifact.source, content: artifact.json },
          { source: artifact.markdownSource, content: artifact.markdown },
        );
        continue;
      }
      const startedMs = Date.now();
      const startedAt = new Date(startedMs).toISOString();
      let result: EvaluationResult;
      try {
        const evaluated = await runBrowserCase({
          browser,
          clientUrl: stack.clientUrl,
          evaluationCase,
          evaluationIdentity: {
            caseExecutionId: `${evaluationCase.id}-v${evaluationCase.version}-r${attempt.repetition}`,
            caseId: evaluationCase.id,
            corpusVersion: String(identities.corpus.version),
            repetition: attempt.repetition,
          },
          rawEvidenceDir: resolve(options.outputDir, "raw/screenshots"),
        });
        result = parseEvaluationResult({
          schemaVersion: 1,
          identities,
          evidenceClass: options.depth === "scripted" ? "infrastructure" : "proficiency",
          execution: {
            state: "completed",
            startedAt,
            finishedAt: new Date().toISOString(),
            durationMs: Date.now() - startedMs,
          },
          ...evaluated,
          proficiency: {
            included: options.depth !== "scripted",
            ...(options.depth === "scripted"
              ? { exclusionReason: "Scripted execution is infrastructure evidence." }
              : {}),
          },
        });
      } catch (error) {
        result = infrastructureFailure({
          identities,
          startedAt,
          startedMs,
          error,
          evaluationCase,
          depth: options.depth,
        });
      }
      results.push(result);
      const artifact = await writeResult(options.outputDir, result);
      generated.push(
        { source: artifact.source, content: artifact.json },
        { source: artifact.markdownSource, content: artifact.markdown },
      );
    }
  } finally {
    await stack?.stop();
    await browser.close();
  }
  const offlineCohort = buildOfflineExperimentCohort({ results, cases });
  const offlineCohortContent = `${JSON.stringify(offlineCohort, null, 2)}\n`;
  const privacy = scanPrivacy([
    ...rawCases,
    ...generated,
    { source: "offline-cohort.json", content: offlineCohortContent },
  ]);
  const verdict = calculateCohortVerdict({ results, requiredAttempts, privacy });
  if (privacy.status === "passed") {
    await writeFile(resolve(options.outputDir, "offline-cohort.json"), offlineCohortContent, { mode: 0o600 });
  }
  await writeRunSummaries(options.outputDir, privacy, verdict);
  return { results, privacy, verdict };
}

export function runScriptedEvaluation(options: {
  repoRoot: string;
  casePaths: string[];
  outputDir: string;
  clientPort: number;
  apiPort: number;
  repetition?: number;
  seed?: number;
}): Promise<EvaluationRun> {
  return runEvaluation({
    ...options,
    depth: "scripted",
    repetitions: options.repetition ?? 1,
  });
}

export const evaluationVersions = {
  evaluator: EVALUATOR_VERSION,
  runner: RUNNER_VERSION,
} as const;
