import { z } from "zod";
import {
  evaluateFusionAttempt,
  FUSION_EFFICIENCY_METRICS,
  fusionCohortContractFailures,
  sha256,
  type EvaluatedFusionAttempt,
  type FusionEvaluationAttempt,
  type FusionEvaluationCorpus,
} from "./evaluation";

const MetadataSchema = z.object({
  comparisonDate: z.string().datetime(),
  reviewerAgreement: z.object({
    humanReviewConfirmed: z.literal(true),
    reviewCohortId: z.string().trim().min(1),
    reviewProtocolVersion: z.string().trim().min(1),
    assignmentsSha256: z.string().regex(/^[a-f0-9]{64}$/),
    reviewedScoresSha256: z.string().regex(/^[a-f0-9]{64}$/),
    method: z.string().trim().min(1),
    value: z.number().min(-1).max(1),
    reviewerCount: z.number().int().min(2),
  }).strict(),
  scope: z.literal("parametric single-part Fusion tasks"),
  limitations: z.array(z.string().trim().min(1)).min(1),
}).strict();

export type FusionSuperiorityGateMetadata = z.infer<typeof MetadataSchema>;

interface ParticipantSummary {
  successes: number;
  attempts: number;
  passRate: number | null;
}

interface PairedConfidenceInterval {
  method: string;
  lower: number;
  upper: number;
  samples: number;
  seed: string;
}

export interface FusionSuperiorityGateResult {
  schemaVersion: 1;
  verdict: "claim-authorized" | "claim-blocked";
  promotionAllowed: boolean;
  comparisonDate: string;
  reasons: string[];
  thresholds: {
    minimumCases: 30;
    requiredTracerFixtures: ["FUS-TEXT-001", "FUS-IMAGE-001", "FUS-TEXT-002"];
    minimumTrialsPerParticipantAndCase: 5;
    minimumAdvantagePercentagePoints: 20;
    confidenceLevel: 0.95;
    maximumPairedStartGapHours: 24;
  };
  summary: {
    chamfer: ParticipantSummary;
    autodesk: ParticipantSummary;
    advantagePercentagePoints: number | null;
    pairedConfidence95: PairedConfidenceInterval | null;
    blindedQualityNoWorse: boolean | null;
    qualityDimensions: Record<string, { chamferMean: number | null; autodeskMean: number | null; delta: number | null }>;
    reviewerAgreement: FusionSuperiorityGateMetadata["reviewerAgreement"] | null;
    efficiency?: Record<string, { chamferMean: number; autodeskMean: number; delta: number; pairedAttempts: number }>;
  };
  schedule: {
    interleaved: boolean;
    maximumConsecutiveParticipantRuns: number;
    maximumPairedStartGapMs: number | null;
    firstAttemptAt?: string;
    lastAttemptFinishedAt?: string;
  };
  cases: Array<{
    caseId: string;
    pairedCaseIdentity: string;
    chamferSuccesses: number;
    autodeskSuccesses: number;
    chamferAttempts: number;
    autodeskAttempts: number;
    chamferIntegrityFailures: number;
    status: "ready" | "incomplete" | "chamfer-integrity-failed";
  }>;
  failureClasses: Record<string, { chamfer: number; autodesk: number; gate: number }>;
  scope: {
    testedScope: string;
    comparisonDate: string;
    chamferRelease: string;
    chamferGitCommit: string;
    chamferAgentConfigurationSha256: string;
    fusionVersion: string;
    autodeskAssistantVersion: string;
    corpusVersion: string;
    corpusSha256: string;
    evaluatorVersion: string;
    limitations: string[];
  };
}

const REQUIRED_TRACERS = ["FUS-TEXT-001", "FUS-IMAGE-001", "FUS-TEXT-002"] as const;
const BOOTSTRAP_SAMPLES = 20_000;

function rounded(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function percentile(sorted: number[], probability: number): number {
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.floor(probability * sorted.length)))]!;
}

function pairedBootstrap95(differences: number[]): PairedConfidenceInterval {
  const seed = sha256(differences);
  let state = Number.parseInt(seed.slice(0, 8), 16) || 0x6d2b79f5;
  const random = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
  const estimates = new Array<number>(BOOTSTRAP_SAMPLES);
  for (let sample = 0; sample < BOOTSTRAP_SAMPLES; sample += 1) {
    let sum = 0;
    for (let index = 0; index < differences.length; index += 1) {
      sum += differences[Math.floor(random() * differences.length)]!;
    }
    estimates[sample] = sum / differences.length;
  }
  estimates.sort((a, b) => a - b);
  return {
    method: "deterministic paired percentile bootstrap over matched case/trial outcomes",
    lower: rounded(percentile(estimates, 0.025)),
    upper: rounded(percentile(estimates, 0.975)),
    samples: BOOTSTRAP_SAMPLES,
    seed,
  };
}

function maximumParticipantRun(attempts: FusionEvaluationAttempt[]): number {
  let maximum = 0;
  let current = 0;
  let preceding: FusionEvaluationAttempt["participant"] | undefined;
  for (const attempt of [...attempts].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))) {
    current = attempt.participant === preceding ? current + 1 : 1;
    preceding = attempt.participant;
    maximum = Math.max(maximum, current);
  }
  return maximum;
}

function evaluateAttemptSafely(
  corpus: FusionEvaluationCorpus,
  attempt: FusionEvaluationAttempt,
): EvaluatedFusionAttempt {
  const evaluationCase = corpus.cases.find((item) => item.id === attempt.caseId && item.version === attempt.caseVersion);
  if (!evaluationCase) return { verdict: "incomplete", eligibleForProficiency: false, semanticReviewPending: false,
    failures: ["attempt references a case outside the authoritative corpus"] };
  try {
    return evaluateFusionAttempt(evaluationCase, attempt);
  } catch (error) {
    return { verdict: "incomplete", eligibleForProficiency: false, semanticReviewPending: false,
      failures: [`invalid pinned evidence: ${error instanceof Error ? error.message : String(error)}`] };
  }
}

function gateSpecificCohortReasons(
  chamfer: FusionEvaluationAttempt[],
  autodesk: FusionEvaluationAttempt[],
): string[] {
  const reasons: string[] = [];
  if (chamfer.some((attempt) => attempt.participant !== "chamfer" || attempt.executionMode !== "live")) {
    reasons.push("The Chamfer cohort must contain only live Chamfer attempts");
  }
  if (autodesk.some((attempt) => attempt.participant !== "autodesk-assistant" || attempt.executionMode !== "ingested")) {
    reasons.push("The Autodesk cohort must contain only ingested Autodesk Assistant attempts");
  }
  return reasons;
}

function meanScore(
  attempts: FusionEvaluationAttempt[],
  dimension: string,
): number | undefined {
  const scores = attempts.map((attempt) => attempt.semantic.scores?.[dimension]);
  if (scores.some((score) => score === undefined)) return undefined;
  return scores.reduce<number>((sum, score) => sum + (score ?? 0), 0) / scores.length;
}

export function buildFusionReviewedScoresIdentity(attempts: FusionEvaluationAttempt[]): string {
  return sha256([...attempts].sort((a, b) => a.attemptId.localeCompare(b.attemptId)).map((attempt) => ({
    attemptId: attempt.attemptId,
    participant: attempt.participant,
    rubricId: attempt.semantic.rubricId,
    rubricVersion: attempt.semantic.rubricVersion,
    status: attempt.semantic.status,
    blinded: attempt.semantic.blinded,
    scores: attempt.semantic.scores,
  })));
}

function countFailures(
  target: Record<string, { chamfer: number; autodesk: number; gate: number }>,
  participant: "chamfer" | "autodesk",
  evaluated: EvaluatedFusionAttempt,
): void {
  if (evaluated.verdict === "passed") return;
  const failures = evaluated.failures.length > 0 ? evaluated.failures : [evaluated.verdict];
  for (const failure of failures) {
    target[failure] ??= { chamfer: 0, autodesk: 0, gate: 0 };
    target[failure][participant] += 1;
  }
}

export function evaluateFusionSuperiorityGate(
  corpus: FusionEvaluationCorpus,
  chamferAttempts: FusionEvaluationAttempt[],
  autodeskAttempts: FusionEvaluationAttempt[],
  requiredTrials: number,
  metadataInput: unknown,
  inputFailures: string[] = [],
): FusionSuperiorityGateResult {
  const parsedMetadata = MetadataSchema.safeParse(metadataInput);
  const metadata = parsedMetadata.success ? parsedMetadata.data : undefined;
  const allAttempts = [...chamferAttempts, ...autodeskAttempts];
  const comparisonTime = metadata ? Date.parse(metadata.comparisonDate) : Number.POSITIVE_INFINITY;
  const reasons = [
    ...inputFailures,
    ...(!metadata ? ["Superiority-gate metadata is malformed or incomplete"] : []),
    ...fusionCohortContractFailures(corpus.cases, chamferAttempts, autodeskAttempts),
    ...gateSpecificCohortReasons(chamferAttempts, autodeskAttempts),
  ];
  const caseIds = new Set(corpus.cases.map((evaluationCase) => evaluationCase.id));
  if (corpus.purpose !== "autodesk-assistant-superiority" || !corpus.sourceSlices || corpus.sourceSlices.length === 0) {
    reasons.push("The gate requires the authoritative composed Autodesk Assistant superiority corpus");
  }
  if (corpus.cases.length < 30) reasons.push("The authoritative corpus contains fewer than 30 cases");
  if (REQUIRED_TRACERS.some((id) => !caseIds.has(id))) reasons.push("The authoritative corpus is missing one or more required tracer fixtures");
  if (requiredTrials < 5) reasons.push("Each participant requires at least 5 trials per case");
  if (allAttempts.some((attempt) => attempt.identity.corpus.version !== corpus.version || attempt.identity.corpus.sha256 !== corpus.sha256)) {
    reasons.push("One or more attempts do not pin the authoritative corpus identity");
  }
  if (allAttempts.some((attempt) => attempt.identity.product.dirty)) reasons.push("Release claims require clean, versioned product builds");
  if (metadata && metadata.reviewerAgreement.reviewedScoresSha256 !== buildFusionReviewedScoresIdentity(allAttempts)) {
    reasons.push("Blinded human-review evidence does not match the scored attempt cohort");
  }
  if (chamferAttempts.length > 0 && autodeskAttempts.length > 0 &&
      sha256(chamferAttempts[0]!.identity.environment) !== sha256(autodeskAttempts[0]!.identity.environment)) {
    reasons.push("Candidate and control trials require equivalent execution environments");
  }
  if (allAttempts.some((attempt) => Date.parse(attempt.startedAt) > Date.parse(attempt.finishedAt) ||
      Date.parse(attempt.finishedAt) > comparisonTime)) {
    reasons.push("Every attempt must be finished and dated before comparison begins");
  }

  const orderedAttempts = [...allAttempts].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  const maximumRun = maximumParticipantRun(orderedAttempts);
  const scheduledPairs = Array.from({ length: Math.ceil(orderedAttempts.length / 2) }, (_, index) =>
    orderedAttempts.slice(index * 2, index * 2 + 2));
  const interleaved = orderedAttempts.length > 0 && orderedAttempts.length % 2 === 0 && scheduledPairs.every(([chamfer, autodesk]) =>
    chamfer?.participant === "chamfer" && autodesk?.participant === "autodesk-assistant" &&
    chamfer.caseId === autodesk.caseId && chamfer.caseVersion === autodesk.caseVersion && chamfer.trial === autodesk.trial);
  const pairedStartGaps = scheduledPairs.map(([first, second]) => first && second ? Date.parse(second.startedAt) - Date.parse(first.startedAt) : Number.POSITIVE_INFINITY);
  const maximumPairedStartGapMs = pairedStartGaps.length > 0 ? Math.max(...pairedStartGaps) : null;
  if (!interleaved) reasons.push("Candidate and control trials are not interleaved");
  if (maximumPairedStartGapMs !== null && maximumPairedStartGapMs > 24 * 60 * 60 * 1_000) {
    reasons.push("Paired candidate and control trials started more than 24 hours apart");
  }

  const evaluatedChamfer = new Map(chamferAttempts.map((attempt) => [attempt, evaluateAttemptSafely(corpus, attempt)]));
  const evaluatedAutodesk = new Map(autodeskAttempts.map((attempt) => [attempt, evaluateAttemptSafely(corpus, attempt)]));
  const attemptKey = (attempt: Pick<FusionEvaluationAttempt, "caseId" | "caseVersion" | "trial">) =>
    `${attempt.caseId}\0${attempt.caseVersion}\0${attempt.trial}`;
  const chamferByTrial = new Map(chamferAttempts.map((attempt) => [attemptKey(attempt), attempt]));
  const autodeskByTrial = new Map(autodeskAttempts.map((attempt) => [attemptKey(attempt), attempt]));
  const pairedOutcomes = corpus.cases.flatMap((evaluationCase) => Array.from({ length: requiredTrials }, (_, index) => {
    const key = attemptKey({ caseId: evaluationCase.id, caseVersion: evaluationCase.version, trial: index + 1 });
    const chamfer = chamferByTrial.get(key);
    const autodesk = autodeskByTrial.get(key);
    return {
      chamfer,
      autodesk,
      chamferResult: chamfer ? evaluatedChamfer.get(chamfer) : undefined,
      autodeskResult: autodesk ? evaluatedAutodesk.get(autodesk) : undefined,
    };
  }));
  const failureClasses: Record<string, { chamfer: number; autodesk: number; gate: number }> = {};
  for (const failure of inputFailures) {
    failureClasses[failure] = {
      chamfer: failure.startsWith("Chamfer ") ? 1 : 0,
      autodesk: failure.startsWith("Autodesk ") ? 1 : 0,
      gate: failure.startsWith("Chamfer ") || failure.startsWith("Autodesk ") ? 0 : 1,
    };
  }
  if (!metadata) failureClasses["malformed or incomplete gate metadata"] = { chamfer: 0, autodesk: 0, gate: 1 };
  for (const evaluated of evaluatedChamfer.values()) countFailures(failureClasses, "chamfer", evaluated);
  for (const evaluated of evaluatedAutodesk.values()) countFailures(failureClasses, "autodesk", evaluated);

  const cases = corpus.cases.map((evaluationCase) => {
    const chamferCaseAttempts = chamferAttempts.filter((attempt) => attempt.caseId === evaluationCase.id && attempt.caseVersion === evaluationCase.version);
    const autodeskCaseAttempts = autodeskAttempts.filter((attempt) => attempt.caseId === evaluationCase.id && attempt.caseVersion === evaluationCase.version);
    const chamferCaseResults = chamferCaseAttempts.map((attempt) => evaluatedChamfer.get(attempt)!);
    const autodeskCaseResults = autodeskCaseAttempts.map((attempt) => evaluatedAutodesk.get(attempt)!);
    const expectedTrials = Array.from({ length: requiredTrials }, (_, index) => index + 1);
    const trialSetComplete = (attempts: FusionEvaluationAttempt[]) => attempts.length === requiredTrials &&
      expectedTrials.every((trial) => attempts.some((attempt) => attempt.trial === trial));
    const incomplete = !trialSetComplete(chamferCaseAttempts) || !trialSetComplete(autodeskCaseAttempts) ||
      [...chamferCaseResults, ...autodeskCaseResults].some((result) => result.verdict === "incomplete");
    const chamferIntegrityFailures = chamferCaseResults.filter((result) => result.verdict === "integrity-failed").length;
    return {
      caseId: evaluationCase.id,
      pairedCaseIdentity: chamferCaseAttempts[0]?.pairedCaseIdentity ?? autodeskCaseAttempts[0]?.pairedCaseIdentity ?? "missing",
      chamferSuccesses: chamferCaseResults.filter((result) => result.verdict === "passed").length,
      autodeskSuccesses: autodeskCaseResults.filter((result) => result.verdict === "passed").length,
      chamferAttempts: chamferCaseAttempts.length,
      autodeskAttempts: autodeskCaseAttempts.length,
      chamferIntegrityFailures,
      status: chamferIntegrityFailures > 0 ? "chamfer-integrity-failed" as const : incomplete ? "incomplete" as const : "ready" as const,
    };
  });
  if (cases.some((item) => item.status === "incomplete")) {
    reasons.push(`Every case requires exactly ${requiredTrials} complete trials per participant`);
  }
  if (cases.some((item) => item.chamferIntegrityFailures > 0)) reasons.push("Chamfer has one or more integrity failures");

  const chamferSuccesses = [...evaluatedChamfer.values()].filter((result) => result.verdict === "passed").length;
  const autodeskSuccesses = [...evaluatedAutodesk.values()].filter((result) => result.verdict === "passed").length;
  let chamferPassRate: number | null = null;
  let autodeskPassRate: number | null = null;
  let advantagePercentagePoints: number | null = null;
  let pairedConfidence95: PairedConfidenceInterval | null = null;
  const qualityDimensions: Record<string, { chamferMean: number | null; autodeskMean: number | null; delta: number | null }> = {};
  let blindedQualityNoWorse: boolean | null = null;
  if (reasons.length === 0) {
    chamferPassRate = chamferSuccesses / chamferAttempts.length;
    autodeskPassRate = autodeskSuccesses / autodeskAttempts.length;
    const advantage = chamferPassRate - autodeskPassRate;
    advantagePercentagePoints = rounded(advantage * 100);
    if (advantage < 0.2) reasons.push("Chamfer full-task pass advantage is below 20 percentage points");

    const pairedDifferences = pairedOutcomes.map((pair) => (pair.chamferResult?.verdict === "passed" ? 1 : 0) -
      (pair.autodeskResult?.verdict === "passed" ? 1 : 0));
    pairedConfidence95 = pairedBootstrap95(pairedDifferences);
    if (pairedConfidence95.lower <= 0) reasons.push("The paired 95 percent confidence interval is not above zero");

    const dimensions = [...new Set(corpus.cases.flatMap((evaluationCase) => evaluationCase.semanticRubric.dimensions))];
    blindedQualityNoWorse = true;
    for (const dimension of dimensions) {
      const chamferMean = meanScore(chamferAttempts, dimension);
      const autodeskMean = meanScore(autodeskAttempts, dimension);
      if (chamferMean === undefined || autodeskMean === undefined || chamferMean < autodeskMean) blindedQualityNoWorse = false;
      qualityDimensions[dimension] = {
        chamferMean: chamferMean === undefined ? null : rounded(chamferMean),
        autodeskMean: autodeskMean === undefined ? null : rounded(autodeskMean),
        delta: chamferMean === undefined || autodeskMean === undefined ? null : rounded(chamferMean - autodeskMean),
      };
    }
    if (!blindedQualityNoWorse) reasons.push("Blinded review finds Chamfer worse on one or more quality dimensions");
  }

  const firstChamfer = chamferAttempts[0]!;
  const firstAutodesk = autodeskAttempts[0]!;
  const verdict = reasons.length === 0 ? "claim-authorized" as const : "claim-blocked" as const;
  const efficiency: NonNullable<FusionSuperiorityGateResult["summary"]["efficiency"]> = {};
  if (verdict === "claim-authorized") {
    for (const metric of FUSION_EFFICIENCY_METRICS) {
      const pairs = pairedOutcomes.map((pair) => {
        if (!pair.chamfer || !pair.autodesk || pair.chamferResult?.verdict !== "passed" ||
            pair.autodeskResult?.verdict !== "passed") return undefined;
        const chamferValue = pair.chamfer.diagnostics[metric];
        const autodeskValue = pair.autodesk.diagnostics[metric];
        return chamferValue === undefined || autodeskValue === undefined ? undefined : { chamferValue, autodeskValue };
      }).filter((pair): pair is { chamferValue: number; autodeskValue: number } => pair !== undefined);
      if (pairs.length === 0) continue;
      const chamferMean = pairs.reduce((sum, pair) => sum + pair.chamferValue, 0) / pairs.length;
      const autodeskMean = pairs.reduce((sum, pair) => sum + pair.autodeskValue, 0) / pairs.length;
      efficiency[metric] = { chamferMean: rounded(chamferMean), autodeskMean: rounded(autodeskMean),
        delta: rounded(chamferMean - autodeskMean), pairedAttempts: pairs.length };
    }
  }
  return {
    schemaVersion: 1,
    verdict,
    promotionAllowed: verdict === "claim-authorized",
    comparisonDate: metadata?.comparisonDate ?? "unavailable",
    reasons,
    thresholds: {
      minimumCases: 30,
      requiredTracerFixtures: [...REQUIRED_TRACERS],
      minimumTrialsPerParticipantAndCase: 5,
      minimumAdvantagePercentagePoints: 20,
      confidenceLevel: 0.95,
      maximumPairedStartGapHours: 24,
    },
    summary: {
      chamfer: { successes: chamferSuccesses, attempts: chamferAttempts.length,
        passRate: chamferPassRate === null ? null : rounded(chamferPassRate) },
      autodesk: { successes: autodeskSuccesses, attempts: autodeskAttempts.length,
        passRate: autodeskPassRate === null ? null : rounded(autodeskPassRate) },
      advantagePercentagePoints,
      pairedConfidence95,
      blindedQualityNoWorse,
      qualityDimensions,
      reviewerAgreement: metadata?.reviewerAgreement ?? null,
      ...(verdict === "claim-authorized" ? { efficiency } : {}),
    },
    schedule: {
      interleaved,
      maximumConsecutiveParticipantRuns: maximumRun,
      maximumPairedStartGapMs,
      ...(allAttempts.length > 0 ? {
        firstAttemptAt: allAttempts.map((attempt) => attempt.startedAt).sort()[0],
        lastAttemptFinishedAt: allAttempts.map((attempt) => attempt.finishedAt).sort().at(-1),
      } : {}),
    },
    cases,
    failureClasses,
    scope: {
      testedScope: metadata?.scope ?? "parametric single-part Fusion tasks",
      comparisonDate: metadata?.comparisonDate ?? "unavailable",
      chamferRelease: firstChamfer?.identity.product.release ?? "missing",
      chamferGitCommit: firstChamfer?.identity.product.gitCommit ?? "missing",
      chamferAgentConfigurationSha256: firstChamfer?.identity.agent.configurationSha256 ?? "missing",
      fusionVersion: firstChamfer?.identity.fusion.version ?? "missing",
      autodeskAssistantVersion: firstAutodesk?.identity.model.model ?? "missing",
      corpusVersion: corpus.version,
      corpusSha256: corpus.sha256,
      evaluatorVersion: firstChamfer?.identity.evaluator.version ?? "missing",
      limitations: metadata?.limitations ?? ["Gate metadata was invalid; no claim scope was authorized."],
    },
  };
}
