import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
  isFusionExpectedEffect,
  type FusionEngineeringSnapshotDto,
  type FusionExpectedEffect,
} from "@chamfer/shared";
import { z } from "zod";

const HASH = /^[a-f0-9]{64}$/;
const NonEmpty = z.string().trim().min(1);
const Hash = z.string().regex(HASH);
const Rgb = z.tuple([
  z.number().int().min(0).max(255),
  z.number().int().min(0).max(255),
  z.number().int().min(0).max(255),
]);
const TypedEffectSchema = z.custom<FusionExpectedEffect>(isFusionExpectedEffect, "invalid Fusion typed effect");

const TextInputSchema = z.object({ kind: z.literal("text"), text: NonEmpty }).strict();
const ImageInputSchema = z.object({ kind: z.literal("image"), assetId: NonEmpty }).strict();
const TurnInputSchema = z.object({ kind: z.literal("turn"), text: NonEmpty }).strict();
const ManualEditInputSchema = z.object({
  kind: z.literal("manual-edit"),
  operation: z.enum(["set-parameter", "edit-feature", "change-material", "change-appearance", "arbitrary-fixture"]),
  fixture: NonEmpty,
}).strict();
const OwnershipTransferInputSchema = z.object({
  kind: z.literal("ownership-transfer"),
  fixture: NonEmpty,
}).strict();

const FusionEvaluationCoverageSchema = z.enum([
  "precision-fit", "datum-relative", "counterbore", "rib-or-gusset", "threaded-hole",
  "one-sided-feature", "fillet", "chamfer", "section-evidence", "material-provenance",
  "separate-appearance", "interruption-safety", "automatic-undo", "hard-recovery",
  "integrity-attack",
]);
const FusionEvaluationAttackVectorSchema = z.enum([
  "endpoint-escape", "python-capability-escape", "raw-mcp-escape", "unrelated-document",
  "evidence-exposure",
]);
const FusionEvaluationFaultSchema = z.object({
  kind: z.enum(["cancellation", "timeout", "mcp-disconnect", "verification-failure", "undo-failure"]),
  trigger: z.enum(["action-lease-held", "post-mutation-verification", "automatic-undo"]),
}).strict();
const FusionEvaluationIntegrityExpectationSchema = z.object({
  overridesScoring: z.literal(true),
  terminalState: z.enum([
    "accepted-revision", "trusted-completion-after-cancel", "prior-revision-restored",
    "hard-recovery", "blocked-without-mutation", "blocked-uncertain-state",
  ]),
  requiredRevisionRelation: z.enum(["new-revision", "exact-preceding-revision", "unchanged", "uncertain-state-blocked"]),
}).strict();
const FusionEvaluationIntegrityProfileSchema = z.object({
  coverage: z.array(FusionEvaluationCoverageSchema).min(1),
  faultInjection: FusionEvaluationFaultSchema.optional(),
  attackVectors: z.array(FusionEvaluationAttackVectorSchema),
  expectation: FusionEvaluationIntegrityExpectationSchema,
  review: z.object({
    status: z.literal("pending-human-review"),
    scope: z.literal("initial-parametric-single-part"),
  }).strict(),
}).strict();

export const FusionEvaluationCaseSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^FUS-[A-Z]+-\d{3}$/),
  version: z.number().int().positive(),
  title: NonEmpty,
  inputs: z.array(z.discriminatedUnion("kind", [
    TextInputSchema, ImageInputSchema, TurnInputSchema, ManualEditInputSchema, OwnershipTransferInputSchema,
  ])).min(1),
  assets: z.array(z.object({
    id: NonEmpty,
    path: NonEmpty.refine((path) => !isAbsolute(path) && !path.split(/[\\/]/).includes(".."), "asset paths must stay repository-relative"),
    mimeType: z.enum(["image/png", "image/jpeg", "image/svg+xml", "text/markdown"]),
    sha256: Hash,
  }).strict()),
  documentSetup: z.object({
    kind: z.enum(["fresh-parametric-part", "pinned-fixture-document"]),
    designHistory: z.literal(true),
    units: z.enum(["mm", "cm", "in"]),
    setupVersion: NonEmpty,
    fixtureAssetId: NonEmpty.optional(),
  }).strict(),
  expectedOutcome: z.enum(["completed", "escalated", "blocked"]),
  requiredEvidence: z.array(z.enum([
    "trusted-inspection", "action-ledger", "typed-checks", "native-undo", "visual-evidence",
    "visual-verification", "source-linked-specifications", "registered-views", "manual-reconciliation",
    "ownership-transfer", "focused-question", "blocking-diagnosis",
  ])).min(1),
  viewRegistrations: z.array(z.object({
    assetIds: z.array(NonEmpty).min(1),
    sharedSpecificationLinks: z.array(NonEmpty).min(1),
  }).strict()).min(1).optional(),
  focusedQuestion: z.object({ requiredTerms: z.array(NonEmpty).min(1) }).strict().optional(),
  forbiddenOutcomes: z.array(NonEmpty).min(1),
  deterministicChecks: z.array(z.object({
    evaluator: z.literal("fusion-typed-effects"),
    version: NonEmpty,
    fixtureId: NonEmpty,
    effects: z.array(z.custom<FusionExpectedEffect>(isFusionExpectedEffect)).min(1).optional(),
  }).strict()).min(1),
  typedEffects: z.array(TypedEffectSchema).min(1).optional(),
  nativeFeatureIntent: z.array(z.enum([
    "constrained-sketch", "extrusion", "revolve", "hole", "counterbore", "pocket",
    "pattern", "parameter", "fillet", "chamfer", "one-solid",
  ])).min(1).optional(),
  dimensionalRequirements: z.array(z.object({
    name: NonEmpty,
    nominalMm: z.number().nonnegative(),
    toleranceMm: z.number().positive(),
  }).strict()).min(1).optional(),
  materialAssignment: z.object({ name: NonEmpty, family: z.enum(["metal", "plastic"]) }).strict().optional(),
  appearanceAssignment: z.object({ name: NonEmpty, targetRgb: Rgb }).strict().optional(),
  difficultyBasis: z.array(NonEmpty).min(1).optional(),
  review: z.object({
    status: z.literal("approved"),
    privacySafe: z.literal(true),
    sequenceNeutral: z.literal(true),
    notes: NonEmpty,
  }).strict().optional(),
  preservationChecks: z.array(z.object({
    afterInput: z.number().int().min(2),
    changedParameters: z.array(NonEmpty).min(1),
  }).strict()).min(1).optional(),
  responseCriteria: z.object({
    requiredSubstrings: z.array(NonEmpty).min(1),
    requireQuestion: z.boolean(),
  }).strict().optional(),
  semanticRubric: z.object({
    id: NonEmpty,
    version: NonEmpty,
    dimensions: z.array(z.enum(["design-intent", "editability", "visual-quality"])).min(1),
  }).strict(),
  interactionBudget: z.object({
    maxUserTurns: z.number().int().positive(),
    maxAgentTurns: z.number().int().positive(),
    maxActions: z.number().int().nonnegative(),
    maxElapsedMs: z.number().int().positive(),
  }).strict(),
  gatingPolicy: z.object({
    id: NonEmpty,
    version: NonEmpty,
    releaseGating: z.boolean(),
    requireDeterministicPass: z.literal(true),
    requireSemanticReview: z.boolean(),
  }).strict(),
  integrityProfile: FusionEvaluationIntegrityProfileSchema.optional(),
}).strict().superRefine((value, context) => {
  const assetIds = new Set(value.assets.map((asset) => asset.id));
  for (const input of value.inputs) {
    if (input.kind === "image" && !assetIds.has(input.assetId)) {
      context.addIssue({ code: "custom", message: `image input references missing asset ${input.assetId}` });
    }
  }
  if (value.documentSetup.fixtureAssetId && !assetIds.has(value.documentSetup.fixtureAssetId)) {
    context.addIssue({ code: "custom", message: `document setup references missing asset ${value.documentSetup.fixtureAssetId}` });
  }
  for (const registration of value.viewRegistrations ?? []) {
    for (const assetId of registration.assetIds) {
      if (!assetIds.has(assetId)) context.addIssue({ code: "custom", message: `view registration references missing asset ${assetId}` });
    }
  }
  if (value.requiredEvidence.includes("registered-views") && !value.viewRegistrations) {
    context.addIssue({ code: "custom", message: "registered-view evidence requires declared view registrations" });
  }
  if (value.requiredEvidence.includes("focused-question") && !value.focusedQuestion && !value.responseCriteria) {
    context.addIssue({ code: "custom", message: "focused-question evidence requires declared required terms or response criteria" });
  }
  if (new Set(value.requiredEvidence).size !== value.requiredEvidence.length) {
    context.addIssue({ code: "custom", message: "required evidence kinds must be unique" });
  }
  const profile = value.integrityProfile;
  if (!profile) return;
  if (new Set(profile.coverage).size !== profile.coverage.length || new Set(profile.attackVectors).size !== profile.attackVectors.length) {
    context.addIssue({ code: "custom", message: "integrity profile coverage and attack vectors must be unique" });
  }
  if (!value.gatingPolicy.releaseGating) {
    context.addIssue({ code: "custom", message: "integrity-profile cases must be release gating" });
  }
  if (!profile.faultInjection && profile.attackVectors.length === 0 &&
      value.deterministicChecks.every((check) => !check.effects)) {
    context.addIssue({ code: "custom", message: "industrial integrity cases require executable typed effects" });
  }
  if (profile.attackVectors.length > 0 && !profile.coverage.includes("integrity-attack")) {
    context.addIssue({ code: "custom", message: "attack vectors require integrity-attack coverage" });
  }
  if (profile.faultInjection?.kind === "cancellation" &&
      (profile.faultInjection.trigger !== "action-lease-held" || profile.expectation.terminalState !== "trusted-completion-after-cancel")) {
    context.addIssue({ code: "custom", message: "cancellation requires leased-action trusted completion" });
  }
  if ((profile.faultInjection?.kind === "timeout" || profile.faultInjection?.kind === "mcp-disconnect") &&
      profile.faultInjection.trigger !== "action-lease-held") {
    context.addIssue({ code: "custom", message: "timeout and MCP disconnect faults require an action lease" });
  }
  if (profile.faultInjection?.kind === "verification-failure" &&
      (profile.expectation.terminalState !== "prior-revision-restored" ||
       profile.expectation.requiredRevisionRelation !== "exact-preceding-revision")) {
    context.addIssue({ code: "custom", message: "verification failure requires exact preceding-revision restoration" });
  }
  if (profile.faultInjection?.kind === "undo-failure" &&
      (profile.expectation.terminalState !== "hard-recovery" ||
       profile.expectation.requiredRevisionRelation !== "uncertain-state-blocked")) {
    context.addIssue({ code: "custom", message: "Undo failure requires hard recovery with uncertain state blocked" });
  }
});

const VersionedHashSchema = z.object({ version: NonEmpty, sha256: Hash }).strict();
export const FusionEvaluationIdentitySchema = z.object({
  product: z.object({ release: NonEmpty, gitCommit: z.string().regex(/^[a-f0-9]{40}$/), dirty: z.boolean() }).strict(),
  connector: VersionedHashSchema,
  agent: VersionedHashSchema.extend({ configurationSha256: Hash }).strict(),
  toolset: VersionedHashSchema,
  model: z.object({ provider: NonEmpty, model: NonEmpty, configurationSha256: Hash }).strict(),
  inferenceSettingsSha256: Hash,
  prompt: VersionedHashSchema,
  policy: VersionedHashSchema,
  skills: VersionedHashSchema,
  evaluator: VersionedHashSchema,
  fusion: z.object({ version: NonEmpty }).strict(),
  mcp: z.object({ name: NonEmpty, version: NonEmpty, protocol: NonEmpty }).strict(),
  corpus: VersionedHashSchema,
  runner: VersionedHashSchema,
  environment: z.object({ nodeVersion: NonEmpty, platform: NonEmpty, arch: NonEmpty, browser: NonEmpty }).strict(),
  parentCohortIds: z.array(NonEmpty),
}).strict();

const ResultStatusSchema = z.enum(["passed", "failed", "unavailable"]);
export const FusionEvaluationAttemptSchema = z.object({
  schemaVersion: z.literal(1),
  attemptId: NonEmpty,
  cohortId: NonEmpty,
  participant: z.enum(["chamfer", "autodesk-assistant"]),
  executionMode: z.enum(["scripted", "live", "ingested"]),
  caseId: NonEmpty,
  caseVersion: z.number().int().positive(),
  pairedCaseIdentity: Hash,
  documentSetupSha256: Hash,
  trial: z.number().int().positive(),
  identity: FusionEvaluationIdentitySchema,
  executionState: z.enum(["finished", "infrastructure-failure", "interrupted", "incomplete"]),
  observedOutcome: z.enum(["completed", "escalated", "blocked"]).optional(),
  evidence: z.array(z.object({ kind: NonEmpty, id: NonEmpty }).strict()),
  forbiddenOutcomesObserved: z.array(NonEmpty).optional(),
  deterministic: z.object({
    status: ResultStatusSchema,
    checks: z.array(z.object({ id: NonEmpty, status: ResultStatusSchema, detail: z.string().optional() }).strict()).min(1),
  }).strict(),
  semantic: z.object({
    status: z.enum(["pending", "passed", "failed", "unavailable"]),
    blinded: z.literal(true),
    rubricId: NonEmpty,
    rubricVersion: NonEmpty,
    scores: z.record(z.string(), z.number()).optional(),
    rationale: z.string().optional(),
  }).strict(),
  integrity: z.object({
    terminalState: FusionEvaluationIntegrityExpectationSchema.shape.terminalState,
    revisionRelation: FusionEvaluationIntegrityExpectationSchema.shape.requiredRevisionRelation,
    fault: FusionEvaluationFaultSchema.extend({ leaseHeldAtInjection: z.boolean() }).strict().optional(),
    blockedAttackVectors: z.array(FusionEvaluationAttackVectorSchema),
  }).strict().optional(),
  diagnostics: z.object({
    costUsd: z.number().nonnegative().optional(),
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    cacheReadTokens: z.number().int().nonnegative().optional(),
    cacheWriteTokens: z.number().int().nonnegative().optional(),
    reasoningTokens: z.number().int().nonnegative().optional(),
    latencyMs: z.number().nonnegative().optional(),
    actionCount: z.number().int().nonnegative(),
    modelCalls: z.number().int().nonnegative().optional(),
    toolCalls: z.number().int().nonnegative().optional(),
    toolErrors: z.number().int().nonnegative().optional(),
    elapsedMs: z.number().nonnegative(),
  }).strict(),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime(),
}).strict();

export type FusionEvaluationCase = z.infer<typeof FusionEvaluationCaseSchema>;
export type FusionEvaluationIdentity = z.infer<typeof FusionEvaluationIdentitySchema>;
export type FusionEvaluationAttempt = z.infer<typeof FusionEvaluationAttemptSchema>;
export type FusionEvaluationDiagnostics = FusionEvaluationAttempt["diagnostics"];

export interface FusionEvaluationCorpus {
  schemaVersion: 1;
  version: string;
  slice?: "foundational-parametric-parts";
  purpose?: "autodesk-assistant-superiority";
  sourceSlices?: Array<{ path: string; version: string; sha256: string }>;
  cases: FusionEvaluationCase[];
  sha256: string;
}

export interface EvaluatedFusionAttempt {
  verdict: "passed" | "proficiency-failed" | "integrity-failed" | "incomplete";
  eligibleForProficiency: boolean;
  semanticReviewPending: boolean;
  failures: string[];
}

function normalized(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(normalized).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${normalized(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : normalized(value)).digest("hex");
}

const PRIVATE_ARTIFACT_PATTERNS = [
  /(?:^|[\s"'])\/(?:home|Users)\//i,
  /[A-Za-z]:\\Users\\/i,
  /\bsk-[A-Za-z0-9_-]{12,}\b/,
  /\b(?:api[_-]?key|authorization)\s*[:=]/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /https?:\/\/(?!127\.0\.0\.1(?::\d+)?(?:\/|$)|localhost(?::\d+)?(?:\/|$))[^\s"']+/i,
];

export function assertFusionEvaluationPrivacySafe(value: unknown): void {
  const serialized = JSON.stringify(value);
  if (PRIVATE_ARTIFACT_PATTERNS.some((pattern) => pattern.test(serialized))) {
    throw new Error("Fusion evaluation privacy scan rejected sensitive or private artifact content");
  }
}

export function buildPairedCaseIdentity(evaluationCase: FusionEvaluationCase): string {
  const parsed = FusionEvaluationCaseSchema.parse(evaluationCase);
  return sha256({
    id: parsed.id,
    version: parsed.version,
    inputs: parsed.inputs,
    assets: parsed.assets,
    documentSetup: parsed.documentSetup,
    interactionBudget: parsed.interactionBudget,
    expectedOutcome: parsed.expectedOutcome,
    requiredEvidence: parsed.requiredEvidence,
    forbiddenOutcomes: parsed.forbiddenOutcomes,
    deterministicChecks: parsed.deterministicChecks,
    typedEffects: parsed.typedEffects,
    nativeFeatureIntent: parsed.nativeFeatureIntent,
    dimensionalRequirements: parsed.dimensionalRequirements,
    materialAssignment: parsed.materialAssignment,
    appearanceAssignment: parsed.appearanceAssignment,
    difficultyBasis: parsed.difficultyBasis,
    review: parsed.review,
    preservationChecks: parsed.preservationChecks,
    responseCriteria: parsed.responseCriteria,
    semanticRubric: parsed.semanticRubric,
    gatingPolicy: parsed.gatingPolicy,
    ...(parsed.integrityProfile ? { integrityProfile: parsed.integrityProfile } : {}),
  });
}

export function validateFusionEvaluationCorpus(input: unknown): FusionEvaluationCorpus {
  const parsed = z.object({
    schemaVersion: z.literal(1),
    version: NonEmpty,
    slice: z.literal("foundational-parametric-parts").optional(),
    cases: z.array(FusionEvaluationCaseSchema).min(1),
  }).strict().parse(input);
  const identities = parsed.cases.map((evaluationCase) => `${evaluationCase.id}@${evaluationCase.version}`);
  if (new Set(identities).size !== identities.length) throw new Error("Fusion evaluation case identities must be unique");
  if (parsed.slice === "foundational-parametric-parts") {
    if (parsed.cases.length !== 10) throw new Error("The foundational Fusion evaluation slice must contain exactly ten cases");
    if (parsed.cases.some((evaluationCase) => !evaluationCase.typedEffects || !evaluationCase.nativeFeatureIntent ||
        !evaluationCase.dimensionalRequirements ||
        !evaluationCase.difficultyBasis || !evaluationCase.review)) {
      throw new Error("Every foundational Fusion case requires dimensions, typed effects, native feature intent, stable difficulty, and review metadata");
    }
    const revisions = parsed.cases.filter((evaluationCase) => evaluationCase.inputs.some((input) => input.kind === "turn"));
    if (revisions.length < 3 || revisions.some((evaluationCase) => !evaluationCase.preservationChecks)) {
      throw new Error("The foundational Fusion slice requires at least three measured targeted revisions");
    }
    if (parsed.cases.some((evaluationCase) => evaluationCase.expectedOutcome !== "completed" && !evaluationCase.responseCriteria)) {
      throw new Error("Every non-completion foundational case requires explicit response criteria");
    }
  }
  assertFusionEvaluationPrivacySafe(parsed);
  return { ...parsed, sha256: sha256(parsed) };
}

export async function loadFusionEvaluationCorpus(path: string, repositoryRoot: string): Promise<FusionEvaluationCorpus> {
  const input: unknown = JSON.parse(await readFile(resolve(repositoryRoot, path), "utf8"));
  const manifest = z.object({
    schemaVersion: z.literal(1),
    kind: z.literal("composed-corpus"),
    purpose: z.literal("autodesk-assistant-superiority"),
    version: NonEmpty,
    slices: z.array(z.object({
      path: NonEmpty.refine((value) => !isAbsolute(value) && !value.split(/[\\/]/).includes(".."), "slice paths must stay repository-relative"),
      version: NonEmpty,
      sha256: Hash,
    }).strict()).min(1),
  }).strict().safeParse(input);
  if (manifest.success) {
    const slices = await Promise.all(manifest.data.slices.map(async (slice) => {
      const loaded = await loadFusionEvaluationCorpus(slice.path, repositoryRoot);
      if (loaded.version !== slice.version || loaded.sha256 !== slice.sha256) {
        throw new Error(`Pinned Fusion evaluation slice ${slice.path} has changed`);
      }
      return loaded;
    }));
    const corpus = validateFusionEvaluationCorpus({
      schemaVersion: 1,
      version: manifest.data.version,
      cases: slices.flatMap((slice) => slice.cases),
    });
    const ids = new Set(corpus.cases.map((evaluationCase) => evaluationCase.id));
    if (corpus.cases.length < 30 || ["FUS-TEXT-001", "FUS-IMAGE-001", "FUS-TEXT-002"].some((id) => !ids.has(id))) {
      throw new Error("The Autodesk Assistant superiority corpus requires at least 30 cases and all three tracer fixtures");
    }
    assertFusionEvaluationPrivacySafe(manifest.data);
    return {
      ...corpus,
      purpose: manifest.data.purpose,
      sourceSlices: manifest.data.slices,
      sha256: sha256(manifest.data),
    };
  }
  const corpus = validateFusionEvaluationCorpus(input);
  for (const evaluationCase of corpus.cases) {
    const markdownContracts: string[] = [];
    for (const asset of evaluationCase.assets) {
      const contents = await readFile(resolve(repositoryRoot, asset.path));
      const actual = createHash("sha256").update(contents).digest("hex");
      if (actual !== asset.sha256) throw new Error(`Pinned asset ${asset.id} for ${evaluationCase.id} has changed`);
      if (asset.mimeType === "text/markdown") {
        const contract = contents.toString("utf8");
        assertFusionEvaluationPrivacySafe(contract);
        markdownContracts.push(contract);
      }
    }
    for (const registration of evaluationCase.viewRegistrations ?? []) {
      for (const link of registration.sharedSpecificationLinks) {
        if (!markdownContracts.some((contract) => contract.includes(`\`${link}\``))) {
          throw new Error(`View registration for ${evaluationCase.id} references unpinned specification ${link}`);
        }
      }
    }
  }
  return corpus;
}

export interface FusionEvaluationCheckpoint {
  afterInput: number;
  revision: string;
  snapshot: FusionEngineeringSnapshotDto;
}

export function evaluateFusionPreservation(
  evaluationCase: FusionEvaluationCase,
  checkpoints: FusionEvaluationCheckpoint[],
): Array<{ id: string; status: "passed" | "failed"; detail: string }> {
  return (evaluationCase.preservationChecks ?? []).map((requirement) => {
    const before = checkpoints.find((checkpoint) => checkpoint.afterInput === requirement.afterInput - 1);
    const after = checkpoints.find((checkpoint) => checkpoint.afterInput === requirement.afterInput);
    const changed = new Set(requirement.changedParameters);
    const precedingParameterNames = new Set(before?.snapshot.parameters.map((parameter) => parameter.name));
    const resultingParameterNames = new Set(after?.snapshot.parameters.map((parameter) => parameter.name));
    const sameParameterSet = precedingParameterNames.size === resultingParameterNames.size &&
      [...precedingParameterNames].every((name) => resultingParameterNames.has(name));
    const revisedParameters = requirement.changedParameters.every((name) => {
      const preceding = before?.snapshot.parameters.find((parameter) => parameter.name === name);
      const resulting = after?.snapshot.parameters.find((parameter) => parameter.name === name);
      return Boolean(preceding && resulting && preceding.id === resulting.id &&
        (preceding.valueMm !== resulting.valueMm || preceding.expression !== resulting.expression));
    });
    const preservedParameters = (before?.snapshot.parameters ?? []).filter((parameter) => !changed.has(parameter.name)).every((preceding) => {
      const resulting = after?.snapshot.parameters.find((parameter) => parameter.name === preceding.name);
      return Boolean(resulting && preceding.id === resulting.id && preceding.valueMm === resulting.valueMm &&
        preceding.expression === resulting.expression && preceding.unit === resulting.unit);
    });
    const preservedFeatures = (before?.snapshot.features ?? []).every((preceding) => {
      const resulting = after?.snapshot.features.find((feature) => feature.name === preceding.name);
      return Boolean(resulting && preceding.id === resulting.id && preceding.type === resulting.type &&
        preceding.timelineIndex === resulting.timelineIndex && preceding.suppressed === resulting.suppressed);
    });
    const sameFeatureSet = before?.snapshot.features.length === after?.snapshot.features.length;
    const preservedAssignments = sha256(before?.snapshot.materials ?? []) === sha256(after?.snapshot.materials ?? []) &&
      sha256((before?.snapshot.bodies ?? []).map(({ id, material, appearance }) => ({ id, material, appearance }))) ===
        sha256((after?.snapshot.bodies ?? []).map(({ id, material, appearance }) => ({ id, material, appearance })));
    const passed = Boolean(before && after && before.revision !== after.revision && sameParameterSet && revisedParameters &&
      preservedParameters && sameFeatureSet && preservedFeatures && preservedAssignments);
    return { id: `targeted-preservation:${requirement.afterInput}`, status: passed ? "passed" : "failed",
      detail: passed ? "Only the declared parameters changed; all other parameters, feature identities, material, appearance, and body identities were preserved."
        : "The targeted revision changed undeclared parameters, feature history, material, appearance, or body identity." };
  });
}

export function matchesFusionResponseCriteria(evaluationCase: FusionEvaluationCase, finalText: string): boolean {
  if (!evaluationCase.responseCriteria) return true;
  const normalized = finalText.toLocaleLowerCase();
  return evaluationCase.responseCriteria.requiredSubstrings.every((value) => normalized.includes(value.toLocaleLowerCase())) &&
    (evaluationCase.responseCriteria.requireQuestion ? finalText.includes("?") : !finalText.includes("?"));
}

export function isUsableFusionAttemptArtifact(evaluated: EvaluatedFusionAttempt): boolean {
  return evaluated.verdict === "passed" || evaluated.verdict === "incomplete" && evaluated.semanticReviewPending;
}

export interface FusionEvaluationPlan {
  schemaVersion: 1;
  kind: "repeated-trial-plan";
  corpusVersion: string;
  corpusSha256: string;
  requiredTrials: number;
  cases: Array<{
    caseId: string;
    caseVersion: number;
    pairedCaseIdentity: string;
    trialNumbers: number[];
    deterministicEffectCount: number;
    faultInjection?: z.infer<typeof FusionEvaluationFaultSchema>;
    attackVectors: Array<z.infer<typeof FusionEvaluationAttackVectorSchema>>;
    reviewStatus?: "pending-human-review";
  }>;
  schedule: Array<{
    sequence: number;
    participant: "chamfer" | "autodesk-assistant";
    caseId: string;
    caseVersion: number;
    pairedCaseIdentity: string;
    trial: number;
  }>;
}

export function buildFusionEvaluationPlan(
  corpus: FusionEvaluationCorpus,
  requiredTrials: number,
  selectedCaseIds: string[] = corpus.cases.map((evaluationCase) => evaluationCase.id),
): FusionEvaluationPlan {
  if (!Number.isInteger(requiredTrials) || requiredTrials < 1) throw new Error("Required trials must be a positive integer");
  const selected = new Set(selectedCaseIds);
  if (selected.size === 0 || selected.size !== selectedCaseIds.length) throw new Error("Evaluation plan case IDs must be nonempty and unique");
  const cases = corpus.cases.filter((evaluationCase) => selected.has(evaluationCase.id));
  if (cases.length !== selected.size) throw new Error("Evaluation plan references an unknown Fusion case");
  const plannedCases = cases.map((evaluationCase) => ({
    caseId: evaluationCase.id,
    caseVersion: evaluationCase.version,
    pairedCaseIdentity: buildPairedCaseIdentity(evaluationCase),
    trialNumbers: Array.from({ length: requiredTrials }, (_, index) => index + 1),
    deterministicEffectCount: evaluationCase.deterministicChecks.reduce((count, check) => count + (check.effects?.length ?? 0), 0),
    ...(evaluationCase.integrityProfile?.faultInjection ? { faultInjection: evaluationCase.integrityProfile.faultInjection } : {}),
    attackVectors: evaluationCase.integrityProfile?.attackVectors ?? [],
    ...(evaluationCase.integrityProfile ? { reviewStatus: evaluationCase.integrityProfile.review.status } : {}),
  }));
  const schedule = plannedCases.flatMap((evaluationCase) => evaluationCase.trialNumbers.flatMap((trial) =>
    (["chamfer", "autodesk-assistant"] as const).map((participant) => ({
      sequence: 0,
      participant,
      caseId: evaluationCase.caseId,
      caseVersion: evaluationCase.caseVersion,
      pairedCaseIdentity: evaluationCase.pairedCaseIdentity,
      trial,
    })))).map((entry, index) => ({ ...entry, sequence: index + 1 }));
  return {
    schemaVersion: 1,
    kind: "repeated-trial-plan",
    corpusVersion: corpus.version,
    corpusSha256: corpus.sha256,
    requiredTrials,
    cases: plannedCases,
    schedule,
  };
}

export function evaluateFusionAttempt(
  evaluationCaseInput: FusionEvaluationCase,
  attemptInput: FusionEvaluationAttempt,
): EvaluatedFusionAttempt {
  const evaluationCase = FusionEvaluationCaseSchema.parse(evaluationCaseInput);
  const attempt = FusionEvaluationAttemptSchema.parse(attemptInput);
  if (attempt.caseId !== evaluationCase.id || attempt.caseVersion !== evaluationCase.version) {
    throw new Error(`Attempt ${attempt.attemptId} targets the wrong Fusion evaluation case`);
  }
  if (attempt.pairedCaseIdentity !== buildPairedCaseIdentity(evaluationCase)) {
    throw new Error(`Attempt ${attempt.attemptId} has a mismatched paired case identity`);
  }
  if (attempt.documentSetupSha256 !== sha256(evaluationCase.documentSetup)) {
    throw new Error(`Attempt ${attempt.attemptId} has a mismatched document setup identity`);
  }
  if (attempt.semantic.rubricId !== evaluationCase.semanticRubric.id ||
      attempt.semantic.rubricVersion !== evaluationCase.semanticRubric.version) {
    throw new Error(`Attempt ${attempt.attemptId} has a mismatched semantic rubric identity`);
  }

  const failures: string[] = [];
  const profile = evaluationCase.integrityProfile;
  if (profile) {
    const observed = attempt.integrity;
    if (!observed) failures.push("required integrity outcome is missing");
    else {
      if (observed.terminalState !== profile.expectation.terminalState) {
        failures.push(`integrity terminal state is ${observed.terminalState}`);
      }
      if (observed.revisionRelation !== profile.expectation.requiredRevisionRelation) {
        failures.push(`integrity revision relation is ${observed.revisionRelation}`);
      }
      if (profile.faultInjection && (!observed.fault || observed.fault.kind !== profile.faultInjection.kind ||
          observed.fault.trigger !== profile.faultInjection.trigger || !observed.fault.leaseHeldAtInjection)) {
        failures.push("declared fault was not injected at its integrity boundary");
      }
      const blockedAttacks = new Set(observed.blockedAttackVectors);
      const unblockedAttacks = profile.attackVectors.filter((vector) => !blockedAttacks.has(vector));
      if (unblockedAttacks.length > 0) failures.push(`unblocked integrity attacks: ${unblockedAttacks.join(", ")}`);
    }
  }
  const forbidden = attempt.forbiddenOutcomesObserved ?? [];
  if (forbidden.length > 0) failures.push(...forbidden.map((value) => `forbidden outcome: ${value}`));
  if (attempt.deterministic.status === "failed" || attempt.deterministic.checks.some((check) => check.status === "failed")) {
    failures.push("deterministic integrity or geometry failed");
  }
  if (failures.length > 0) return { verdict: "integrity-failed", eligibleForProficiency: false, semanticReviewPending: false, failures };

  const evidence = new Set(attempt.evidence.map((item) => item.kind));
  const missingEvidence = evaluationCase.requiredEvidence.filter((kind) => !evidence.has(kind));
  if (attempt.executionState !== "finished") failures.push(`execution state is ${attempt.executionState}`);
  if (attempt.deterministic.status === "unavailable" || attempt.deterministic.checks.some((check) => check.status === "unavailable")) {
    failures.push("required deterministic evaluation is unavailable");
  }
  if (missingEvidence.length > 0) failures.push(`missing evidence: ${missingEvidence.join(", ")}`);
  if (!attempt.observedOutcome) failures.push("observed outcome is missing");
  if (attempt.diagnostics.actionCount > evaluationCase.interactionBudget.maxActions) failures.push("action budget exceeded");
  const userTurns = evaluationCase.inputs.filter((input) => input.kind === "text" || input.kind === "turn").length;
  if (userTurns > evaluationCase.interactionBudget.maxUserTurns) failures.push("user-turn budget exceeded");
  if (attempt.diagnostics.modelCalls === undefined) failures.push("agent-turn count is unavailable");
  else if (attempt.diagnostics.modelCalls > evaluationCase.interactionBudget.maxAgentTurns) failures.push("agent-turn budget exceeded");
  if (attempt.diagnostics.elapsedMs > evaluationCase.interactionBudget.maxElapsedMs) failures.push("elapsed-time budget exceeded");
  if (failures.length > 0) return { verdict: "incomplete", eligibleForProficiency: false, semanticReviewPending: false, failures };

  if (attempt.observedOutcome !== evaluationCase.expectedOutcome) {
    return { verdict: "proficiency-failed", eligibleForProficiency: attempt.executionMode !== "scripted", semanticReviewPending: false,
      failures: [`expected ${evaluationCase.expectedOutcome}, observed ${attempt.observedOutcome}`] };
  }
  if (evaluationCase.gatingPolicy.requireSemanticReview && attempt.executionMode !== "scripted" &&
      (attempt.semantic.status === "unavailable" || attempt.semantic.status === "pending")) {
    return { verdict: "incomplete", eligibleForProficiency: false,
      failures: [`required semantic review is ${attempt.semantic.status}`],
      semanticReviewPending: attempt.semantic.status === "pending" };
  }
  if (evaluationCase.gatingPolicy.requireSemanticReview && attempt.semantic.status === "failed") {
    return { verdict: "proficiency-failed", eligibleForProficiency: attempt.executionMode !== "scripted",
      semanticReviewPending: false, failures: ["semantic rubric failed"] };
  }
  return {
    verdict: "passed",
    eligibleForProficiency: attempt.executionMode !== "scripted",
    semanticReviewPending: evaluationCase.gatingPolicy.requireSemanticReview && attempt.semantic.status === "pending",
    failures: [],
  };
}

export interface FusionCaseComparison {
  caseId: string;
  pairedCaseIdentity: string;
  status: "ready" | "incomplete" | "integrity-failed";
  chamferAttempts: number;
  autodeskAttempts: number;
  chamferPasses: number;
  autodeskPasses: number;
  efficiencyCompared: boolean;
  efficiency?: Record<string, { chamfer: number; autodesk: number; delta: number }>;
  semanticReviewPending: boolean;
}

export interface FusionCohortComparison {
  schemaVersion: 1;
  verdict: "ready" | "incomplete" | "integrity-failed";
  requiredTrials: number;
  cases: FusionCaseComparison[];
}

function uniqueAttemptFailures(attempts: FusionEvaluationAttempt[]): string[] {
  const failures: string[] = [];
  const identities = attempts.map((attempt) => attempt.attemptId);
  if (new Set(identities).size !== identities.length) failures.push("Duplicate attempt identity in Fusion evaluation cohort");
  const trials = attempts.map((attempt) => `${attempt.participant}\0${attempt.caseId}\0${attempt.caseVersion}\0${attempt.trial}`);
  if (new Set(trials).size !== trials.length) failures.push("Duplicate attempt trial in Fusion evaluation cohort");
  return failures;
}

function pinnedCohortFailure(attempts: FusionEvaluationAttempt[], label: string): string | undefined {
  if (attempts.length === 0) return undefined;
  if (new Set(attempts.map((attempt) => attempt.cohortId)).size !== 1 ||
      new Set(attempts.map((attempt) => sha256(attempt.identity))).size !== 1) {
    return `${label} cohort must use one pinned identity`;
  }
  return undefined;
}

export const FUSION_EFFICIENCY_METRICS = ["costUsd", "inputTokens", "outputTokens", "latencyMs", "actionCount", "elapsedMs"] as const;

function compareEfficiency(chamfer: FusionEvaluationAttempt[], autodesk: FusionEvaluationAttempt[]): FusionCaseComparison["efficiency"] {
  const result: NonNullable<FusionCaseComparison["efficiency"]> = {};
  for (const metric of FUSION_EFFICIENCY_METRICS) {
    const chamferValues = chamfer.map((attempt) => attempt.diagnostics[metric]).filter((value): value is number => value !== undefined);
    const autodeskValues = autodesk.map((attempt) => attempt.diagnostics[metric]).filter((value): value is number => value !== undefined);
    if (chamferValues.length !== chamfer.length || autodeskValues.length !== autodesk.length) continue;
    const chamferMean = chamferValues.reduce((sum, value) => sum + value, 0) / chamferValues.length;
    const autodeskMean = autodeskValues.reduce((sum, value) => sum + value, 0) / autodeskValues.length;
    result[metric] = { chamfer: chamferMean, autodesk: autodeskMean, delta: chamferMean - autodeskMean };
  }
  return result;
}

export function fusionCohortContractFailures(
  cases: FusionEvaluationCase[],
  chamfer: FusionEvaluationAttempt[],
  autodesk: FusionEvaluationAttempt[],
): string[] {
  const failures: string[] = [];
  const knownCases = new Set(cases.map((item) => `${item.id}\0${item.version}`));
  const outsideCorpus = [...chamfer, ...autodesk].find((attempt) => !knownCases.has(`${attempt.caseId}\0${attempt.caseVersion}`));
  if (outsideCorpus) failures.push(`Attempt ${outsideCorpus.attemptId} references a case outside the compared corpus`);
  if (chamfer.some((attempt) => attempt.participant !== "chamfer")) failures.push("Chamfer cohort contains another participant");
  if (autodesk.some((attempt) => attempt.participant !== "autodesk-assistant")) failures.push("Autodesk cohort contains another participant");
  if ([...chamfer, ...autodesk].some((attempt) => attempt.executionMode === "scripted")) {
    failures.push("Scripted infrastructure evidence cannot enter a paired proficiency comparison");
  }
  failures.push(...uniqueAttemptFailures([...chamfer, ...autodesk]));
  const chamferPin = pinnedCohortFailure(chamfer, "Chamfer");
  const autodeskPin = pinnedCohortFailure(autodesk, "Autodesk");
  if (chamferPin) failures.push(chamferPin);
  if (autodeskPin) failures.push(autodeskPin);
  if (chamfer.length > 0 && autodesk.length > 0) {
    const compatible = chamfer[0]!.identity.corpus.version === autodesk[0]!.identity.corpus.version &&
      chamfer[0]!.identity.corpus.sha256 === autodesk[0]!.identity.corpus.sha256 &&
      chamfer[0]!.identity.fusion.version === autodesk[0]!.identity.fusion.version &&
      sha256(chamfer[0]!.identity.mcp) === sha256(autodesk[0]!.identity.mcp) &&
      sha256(chamfer[0]!.identity.evaluator) === sha256(autodesk[0]!.identity.evaluator);
    if (!compatible) failures.push("Paired cohorts have incompatible corpus, Fusion, MCP, or evaluator identities");
  }
  return failures;
}

export function compareFusionCohorts(
  caseInputs: FusionEvaluationCase[],
  chamferInputs: FusionEvaluationAttempt[],
  autodeskInputs: FusionEvaluationAttempt[],
  requiredTrials: number,
): FusionCohortComparison {
  if (!Number.isInteger(requiredTrials) || requiredTrials < 1) throw new Error("Required trials must be a positive integer");
  const cases = caseInputs.map((value) => FusionEvaluationCaseSchema.parse(value));
  const chamfer = chamferInputs.map((value) => FusionEvaluationAttemptSchema.parse(value));
  const autodesk = autodeskInputs.map((value) => FusionEvaluationAttemptSchema.parse(value));
  const contractFailures = fusionCohortContractFailures(cases, chamfer, autodesk);
  if (contractFailures.length > 0) throw new Error(contractFailures[0]);

  const comparisons = cases.map((evaluationCase): FusionCaseComparison => {
    const pairedCaseIdentity = buildPairedCaseIdentity(evaluationCase);
    const chamferAttempts = chamfer.filter((attempt) => attempt.caseId === evaluationCase.id && attempt.caseVersion === evaluationCase.version);
    const autodeskAttempts = autodesk.filter((attempt) => attempt.caseId === evaluationCase.id && attempt.caseVersion === evaluationCase.version);
    const evaluatedChamfer = chamferAttempts.map((attempt) => evaluateFusionAttempt(evaluationCase, attempt));
    const evaluatedAutodesk = autodeskAttempts.map((attempt) => evaluateFusionAttempt(evaluationCase, attempt));
    const all = [...evaluatedChamfer, ...evaluatedAutodesk];
    const complete = chamferAttempts.length === requiredTrials && autodeskAttempts.length === requiredTrials &&
      chamferAttempts.every((attempt) => attempt.trial <= requiredTrials) && autodeskAttempts.every((attempt) => attempt.trial <= requiredTrials);
    const integrityFailed = all.some((result) => result.verdict === "integrity-failed");
    const chamferPasses = evaluatedChamfer.filter((result) => result.verdict === "passed").length;
    const autodeskPasses = evaluatedAutodesk.filter((result) => result.verdict === "passed").length;
    const equivalentSuccessfulOutcomes = complete && chamferPasses === requiredTrials && autodeskPasses === requiredTrials;
    return {
      caseId: evaluationCase.id,
      pairedCaseIdentity,
      status: integrityFailed ? "integrity-failed" : !complete || all.some((result) => result.verdict === "incomplete") ? "incomplete" : "ready",
      chamferAttempts: chamferAttempts.length,
      autodeskAttempts: autodeskAttempts.length,
      chamferPasses,
      autodeskPasses,
      efficiencyCompared: equivalentSuccessfulOutcomes,
      ...(equivalentSuccessfulOutcomes ? { efficiency: compareEfficiency(chamferAttempts, autodeskAttempts) } : {}),
      semanticReviewPending: all.some((result) => result.semanticReviewPending),
    };
  });

  const verdict = comparisons.some((comparison) => comparison.status === "integrity-failed") ? "integrity-failed"
    : comparisons.some((comparison) => comparison.status === "incomplete") ? "incomplete" : "ready";
  return { schemaVersion: 1, verdict, requiredTrials, cases: comparisons };
}
