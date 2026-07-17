import { z } from "zod";
import type { EvaluationIdentities } from "./identity";

const hashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const identitySchema = z.object({
  corpus: z.object({ id: z.string().min(1), version: z.number().int().positive(), hash: hashSchema }),
  case: z.object({
    id: z.string().min(1),
    version: z.number().int().positive(),
    hash: hashSchema,
    purpose: z.string().min(1),
    modality: z.enum(["text", "image", "multi-turn"]),
    complexity: z.enum(["smoke", "standard", "challenge"]),
    categories: z.array(z.string().min(1)).min(1),
    gatingStatus: z.enum(["release", "frontier"]),
  }),
  assets: z.array(z.object({ id: z.string().min(1), hash: hashSchema })),
  agentConfiguration: z.object({
    hash: hashSchema,
    productRelease: z.string().min(1),
    gitCommit: z.string().min(1),
    dirty: z.boolean(),
    promptHash: z.string().min(1),
    skillHash: z.string().min(1),
    policyHash: z.string().min(1),
    toolsetHash: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().min(1),
    inferenceSettingsHash: hashSchema,
  }),
  evaluators: z.array(z.object({
    id: z.string().min(1),
    version: z.number().int().positive(),
    required: z.boolean(),
    hash: hashSchema,
  })),
  rubrics: z.array(z.object({
    id: z.string().min(1),
    version: z.number().int().positive(),
    required: z.boolean(),
    hash: hashSchema,
  })),
  runner: z.object({ version: z.number().int().positive(), hash: hashSchema }),
  environment: z.object({
    hash: hashSchema,
    node: z.string().min(1),
    browser: z.string().min(1),
    operatingSystem: z.string().min(1),
    architecture: z.string().min(1),
    productBuildHash: z.string().min(1),
  }),
  repetition: z.object({ index: z.number().int().positive(), hash: hashSchema }),
});

export const evaluationResultSchema = z.object({
  schemaVersion: z.literal(1),
  identities: identitySchema,
  evidenceClass: z.enum(["infrastructure", "proficiency"]),
  execution: z.object({
    state: z.enum(["completed", "failed", "interrupted", "incomplete"]),
    startedAt: z.string().datetime(),
    finishedAt: z.string().datetime(),
    durationMs: z.number().nonnegative(),
    error: z.string().min(1).optional(),
  }),
  outcome: z.object({
    kind: z.enum([
      "completed",
      "escalated",
      "blocked",
      "infrastructure-failure",
      "interrupted",
      "incomplete",
    ]),
    expectedMatch: z.boolean(),
    explanation: z.string().min(1).optional(),
  }),
  evidence: z.array(z.object({
    id: z.string().min(1),
    kind: z.enum([
      "conversation",
      "cad-artifact",
      "verification-gate",
      "geometry-measurement",
      "plan",
      "visual-verification",
      "escalation",
      "blocked-reason",
      "screenshot",
    ]),
    reference: z.string().min(1),
  })),
  measurements: z.object({
    gatePassed: z.boolean().optional(),
    bodyCount: z.number().int().nonnegative().optional(),
    boundingBoxMm: z.tuple([z.number(), z.number(), z.number()]).optional(),
    cadRuns: z.number().int().nonnegative(),
    modelCalls: z.number().int().nonnegative(),
    toolCalls: z.number().int().nonnegative(),
    toolErrors: z.number().int().nonnegative(),
    searches: z.number().int().nonnegative().optional(),
    skillLoads: z.number().int().nonnegative().optional(),
    retries: z.number().int().nonnegative().optional(),
    compactions: z.number().int().nonnegative().optional(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative(),
    cacheWriteTokens: z.number().int().nonnegative(),
    reasoningTokens: z.number().int().nonnegative(),
    providerCost: z.number().nonnegative(),
    modelLatencyMs: z.number().nonnegative().optional(),
    toolLatencyMs: z.number().nonnegative().optional(),
    cadLatencyMs: z.number().nonnegative().optional(),
    compactionLatencyMs: z.number().nonnegative().optional(),
    persistenceLatencyMs: z.number().nonnegative().optional(),
    retryDelayMs: z.number().nonnegative().optional(),
    persistenceFailures: z.number().int().nonnegative().optional(),
  }),
  scores: z.array(z.object({
    id: z.string().min(1),
    evaluatorVersion: z.number().int().positive(),
    status: z.enum(["passed", "failed", "unavailable"]),
    required: z.boolean(),
    value: z.number().optional(),
    explanation: z.string().min(1).optional(),
    evidenceIds: z.array(z.string().min(1)),
  })),
  proficiency: z.object({
    included: z.boolean(),
    exclusionReason: z.string().min(1).optional(),
  }),
  integrity: z.object({
    violations: z.array(z.enum([
      "known-negative-success",
      "requirement-weakening",
      "stale-evidence-success",
      "evaluator-fail-open",
    ])),
  }),
}).superRefine((result, context) => {
  if (result.evidenceClass === "infrastructure" && result.proficiency.included) {
    context.addIssue({
      code: "custom",
      path: ["proficiency", "included"],
      message: "Scripted infrastructure evidence cannot enter the agent proficiency denominator",
    });
  }
  if (!result.proficiency.included && !result.proficiency.exclusionReason) {
    context.addIssue({
      code: "custom",
      path: ["proficiency", "exclusionReason"],
      message: "Excluded proficiency evidence requires a reason",
    });
  }
  const evidenceIds = new Set(result.evidence.map((evidence) => evidence.id));
  for (const score of result.scores) {
    for (const evidenceId of score.evidenceIds) {
      if (!evidenceIds.has(evidenceId)) {
        context.addIssue({
          code: "custom",
          path: ["scores"],
          message: `Score ${score.id} references unknown evidence ${evidenceId}`,
        });
      }
    }
  }
});

export type EvaluationResult = z.infer<typeof evaluationResultSchema> & {
  identities: EvaluationIdentities;
};

export function parseEvaluationResult(value: unknown): EvaluationResult {
  const parsed = evaluationResultSchema.safeParse(value);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid evaluation result: ${details}`);
  }
  return parsed.data as EvaluationResult;
}

export function serializeEvaluationResult(result: EvaluationResult): string {
  return `${JSON.stringify(parseEvaluationResult(result), null, 2)}\n`;
}

function tableValue(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

export function renderEvaluationMarkdown(result: EvaluationResult): string {
  const parsed = parseEvaluationResult(result);
  const lines = [
    `# Evaluation: ${parsed.identities.case.id} v${parsed.identities.case.version}`,
    "",
    "## Outcome",
    "",
    "| Measure | Value |",
    "| --- | --- |",
    `| Execution | ${parsed.execution.state} |`,
    `| Outcome | ${parsed.outcome.kind} |`,
    `| Expected outcome matched | ${parsed.outcome.expectedMatch ? "yes" : "no"} |`,
    `| Evidence class | ${parsed.evidenceClass} |`,
    `| Proficiency denominator | ${parsed.proficiency.included ? "included" : "excluded"} |`,
    "",
  ];
  if (parsed.proficiency.exclusionReason) {
    lines.push(parsed.proficiency.exclusionReason, "");
  }
  lines.push(
    "## Scores",
    "",
    "| Evaluator | Status | Policy |",
    "| --- | --- | --- |",
    ...parsed.scores.map((score) =>
      `| ${tableValue(score.id)} v${score.evaluatorVersion} | ${score.status} | ${score.required ? "required" : "optional"} |`
    ),
    "",
    "## Measurements",
    "",
    `CAD runs: ${parsed.measurements.cadRuns}.`,
    `Model calls: ${parsed.measurements.modelCalls}.`,
    `Tool calls: ${parsed.measurements.toolCalls}.`,
    `Duration: ${parsed.execution.durationMs} ms.`,
    "",
  );
  return lines.join("\n");
}
