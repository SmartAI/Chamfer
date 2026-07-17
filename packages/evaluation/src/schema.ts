import { Type, type Static } from "typebox";
import { Check, Errors } from "typebox/value";

export const EVALUATION_SCHEMA_VERSION = 1 as const;

export const EvaluationCategorySchema = Type.Union([
  Type.Literal("precise-text"),
  Type.Literal("dimensioned-reference"),
  Type.Literal("adversarial-weakening"),
  Type.Literal("conflicting-evidence"),
  Type.Literal("impossible-or-blocked"),
]);

export const ExpectedOutcomeSchema = Type.Union([
  Type.Literal("proven"),
  Type.Literal("escalated"),
  Type.Literal("blocked"),
]);

export const RequiredProofEvidenceSchema = Type.Union([
  Type.Literal("proof-report"),
  Type.Literal("proof-contract"),
  Type.Literal("verification-gate"),
  Type.Literal("plan-completion"),
  Type.Literal("artifact-identity"),
  Type.Literal("visual-verification"),
  Type.Literal("shape-proof"),
  Type.Literal("focused-question"),
  Type.Literal("blocked-reason"),
  Type.Literal("rejected-weakening"),
]);

export const SourceSafetySchema = Type.Object({
  classification: Type.Union([
    Type.Literal("minimal-synthetic"),
    Type.Literal("consent-safe-reconstruction"),
  ]),
  containsRawConversation: Type.Literal(false),
  containsRawUserEvidence: Type.Literal(false),
  containsPii: Type.Literal(false),
  containsCredentials: Type.Literal(false),
}, { additionalProperties: false });

export const ModelIdentitySchema = Type.Object({
  provider: Type.String({ minLength: 1 }),
  model: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

export const ReleasePolicySchema = Type.Object({
  requiredCaseCount: Type.Integer({ minimum: 50 }),
  requiredCategoryCounts: Type.Object({
    "precise-text": Type.Integer({ minimum: 12 }),
    "dimensioned-reference": Type.Integer({ minimum: 18 }),
    "adversarial-weakening": Type.Integer({ minimum: 8 }),
    "conflicting-evidence": Type.Integer({ minimum: 6 }),
    "impossible-or-blocked": Type.Integer({ minimum: 6 }),
  }, { additionalProperties: false }),
  requiredRunsPerCase: Type.Integer({ minimum: 3 }),
  minimumSolvableCompletionRate: Type.Number({ minimum: 0.8, maximum: 1 }),
  supportedModelConfigurations: Type.Array(ModelIdentitySchema, { minItems: 1 }),
  deterministicFixturePath: Type.String({ pattern: "^corpus/[a-z0-9][a-z0-9./-]+\\.json$" }),
}, { additionalProperties: false });

export const EvaluationTaskSchema = Type.Object({
  schemaVersion: Type.Literal(EVALUATION_SCHEMA_VERSION),
  id: Type.String({ pattern: "^[a-z0-9][a-z0-9-]{2,63}$" }),
  taskVersion: Type.Integer({ minimum: 1 }),
  category: EvaluationCategorySchema,
  prompt: Type.String({ minLength: 1, maxLength: 2_000 }),
  expectedOutcome: ExpectedOutcomeSchema,
  requiredProofEvidence: Type.Array(RequiredProofEvidenceSchema, { uniqueItems: true }),
  modelConfiguration: Type.Object({
    provider: Type.String({ minLength: 1 }),
    model: Type.String({ minLength: 1 }),
    repetitions: Type.Integer({ minimum: 1, maximum: 20 }),
  }, { additionalProperties: false }),
  proofPolicy: Type.Object({
    id: Type.String({ minLength: 1 }),
    version: Type.Integer({ minimum: 1 }),
  }, { additionalProperties: false }),
  sourceSafety: Type.Optional(SourceSafetySchema),
  attachment: Type.Optional(Type.Object({
    kind: Type.Literal("synthetic-orthographic-v1"),
    name: Type.String({ pattern: "^[a-z0-9][a-z0-9.-]+$" }),
  }, { additionalProperties: false })),
  knownNegative: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });

export const EvaluationCorpusSchema = Type.Object({
  schemaVersion: Type.Literal(EVALUATION_SCHEMA_VERSION),
  corpusId: Type.String({ pattern: "^[a-z0-9][a-z0-9-]{2,63}$" }),
  corpusVersion: Type.Integer({ minimum: 1 }),
  releasePolicy: Type.Optional(ReleasePolicySchema),
  tasks: Type.Array(EvaluationTaskSchema, { minItems: 1 }),
}, { additionalProperties: false });

export type EvaluationCategory = Static<typeof EvaluationCategorySchema>;
export type ExpectedOutcome = Static<typeof ExpectedOutcomeSchema>;
export type RequiredProofEvidence = Static<typeof RequiredProofEvidenceSchema>;
export type EvaluationTask = Static<typeof EvaluationTaskSchema>;
export type EvaluationCorpus = Static<typeof EvaluationCorpusSchema>;
export type ModelIdentity = Static<typeof ModelIdentitySchema>;
export type ReleasePolicy = Static<typeof ReleasePolicySchema>;

function validationMessage(schema: object, value: unknown): string {
  const errors = [...Errors(schema, value)].slice(0, 5);
  return errors.map((error) => `${error.instancePath || "/"}: ${error.message}`).join("; ");
}

export function parseEvaluationCorpus(value: unknown): EvaluationCorpus {
  if (!Check(EvaluationCorpusSchema, value)) {
    throw new Error(`Invalid evaluation corpus: ${validationMessage(EvaluationCorpusSchema, value)}`);
  }
  const ids = new Set<string>();
  for (const task of value.tasks) {
    if (ids.has(task.id)) throw new Error(`Invalid evaluation corpus: duplicate task id ${task.id}`);
    ids.add(task.id);
    if (task.category === "dimensioned-reference" && !task.attachment) {
      throw new Error(`Invalid evaluation corpus: ${task.id} requires synthetic reference evidence`);
    }
  }
  return value;
}

export function parseReleaseEvaluationCorpus(value: unknown): EvaluationCorpus & { releasePolicy: ReleasePolicy } {
  const corpus = parseEvaluationCorpus(value);
  if (!corpus.releasePolicy) throw new Error("Invalid release evaluation corpus: releasePolicy is required");
  for (const task of corpus.tasks) {
    if (!task.sourceSafety) {
      throw new Error(`Invalid release evaluation corpus: ${task.id} requires source-safety classification`);
    }
  }
  const configurations = new Set<string>();
  for (const configuration of corpus.releasePolicy.supportedModelConfigurations) {
    const key = `${configuration.provider}/${configuration.model}`;
    if (configurations.has(key)) {
      throw new Error(`Invalid release evaluation corpus: duplicate supported model configuration ${key}`);
    }
    configurations.add(key);
  }
  for (const task of corpus.tasks) {
    const key = `${task.modelConfiguration.provider}/${task.modelConfiguration.model}`;
    if (!configurations.has(key)) {
      throw new Error(`Invalid release evaluation corpus: ${task.id} uses unsupported model configuration ${key}`);
    }
    if (task.modelConfiguration.repetitions !== corpus.releasePolicy.requiredRunsPerCase) {
      throw new Error(
        `Invalid release evaluation corpus: ${task.id} must request exactly ` +
        `${corpus.releasePolicy.requiredRunsPerCase} repetitions`,
      );
    }
  }
  return corpus as EvaluationCorpus & { releasePolicy: ReleasePolicy };
}
