import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import { z } from "zod";

const stableId = z.string().regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/);
const version = z.number().int().positive();

const assetSchema = z.object({
  id: stableId,
  path: z.string().min(1).refine(
    (path) => !isAbsolute(path) && !path.split(/[\\/]/).includes(".."),
    "Asset path must be relative to the case and cannot escape its directory",
  ),
  mimeType: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  provenance: z.enum(["synthetic", "generated", "consent-safe", "redistributable"]),
  expectedRole: z.enum(["visual-reference", "dimensioned-orthographic", "complementary-view"]),
  provenanceNotes: z.string().min(1),
});

const evaluatorRefSchema = z.object({
  id: stableId,
  version,
  required: z.boolean(),
  config: z.record(z.string(), z.unknown()),
});

const rubricRefSchema = z.object({
  id: stableId,
  version,
  required: z.boolean(),
});

const requirementSchema = z.object({
  id: stableId,
  description: z.string().min(1),
  evaluation: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("deterministic"), evaluatorId: stableId }),
    z.object({ kind: z.literal("semantic"), rubricId: stableId }),
  ]),
});

const completedOutcomeSchema = z.object({
  kind: z.literal("completed"),
  requirements: z.array(requirementSchema).min(1),
});

const escalatedOutcomeSchema = z.object({
  kind: z.literal("escalated"),
  requirements: z.array(requirementSchema).min(1),
  escalation: z.object({
    question: z.string().min(1),
    unresolvedChoice: z.string().min(1),
    retainedRequirementIds: z.array(stableId).min(1),
  }),
});

const blockedOutcomeSchema = z.object({
  kind: z.literal("blocked"),
  requirements: z.array(requirementSchema).min(1),
  blocking: z.object({
    reasonCode: stableId,
    limitation: z.string().min(1),
    retainedRequirementIds: z.array(stableId).min(1),
  }),
});

export const evaluationCaseSchema = z.object({
  schemaVersion: z.literal(1),
  id: stableId,
  version,
  title: z.string().min(1),
  purpose: z.string().min(1),
  capability: stableId,
  modality: z.enum(["text", "image", "multi-turn"]),
  complexity: z.enum(["smoke", "standard", "challenge"]),
  complexityRationale: z.string().min(20),
  categories: z.array(stableId).min(1),
  gatingStatus: z.enum(["release", "frontier"]),
  capabilityStatus: z.enum(["supported", "frontier"]),
  inputs: z.object({
    turns: z.array(z.object({
      role: z.literal("user"),
      text: z.string().min(1),
      assetIds: z.array(stableId).optional(),
    })).min(1),
    assets: z.array(assetSchema),
  }),
  expectedOutcome: z.discriminatedUnion("kind", [
    completedOutcomeSchema,
    escalatedOutcomeSchema,
    blockedOutcomeSchema,
  ]),
  requiredEvidence: z.array(z.object({
    id: stableId,
    kind: z.enum([
      "verification-gate",
      "geometry-measurement",
      "plan-check",
      "visual-verification",
      "escalation",
      "blocked-reason",
    ]),
    evaluatorId: stableId,
  })),
  forbiddenOutcomes: z.array(z.object({
    kind: z.enum([
      "false-success",
      "known-negative-success",
      "requirement-weakening",
      "stale-evidence-success",
      "generic-refusal",
    ]),
    reason: z.string().min(1),
  })),
  evaluatorRefs: z.array(evaluatorRefSchema),
  rubricRefs: z.array(rubricRefSchema),
  sourceSafety: z.object({
    classification: z.enum(["synthetic", "generated", "consent-safe", "redistributable"]),
    containsProductionData: z.literal(false),
    notes: z.string().min(1),
  }),
}).superRefine((value, context) => {
  const evaluatorIds = new Set(value.evaluatorRefs.map((reference) => reference.id));
  if (evaluatorIds.size !== value.evaluatorRefs.length) {
    context.addIssue({ code: "custom", path: ["evaluatorRefs"], message: "Evaluator ids must be unique" });
  }
  const rubricIds = new Set(value.rubricRefs.map((reference) => reference.id));
  if (rubricIds.size !== value.rubricRefs.length) {
    context.addIssue({ code: "custom", path: ["rubricRefs"], message: "Rubric ids must be unique" });
  }
  for (const evidence of value.requiredEvidence) {
    if (!evaluatorIds.has(evidence.evaluatorId)) {
      context.addIssue({
        code: "custom",
        path: ["requiredEvidence"],
        message: `Required evidence references unknown evaluator ${evidence.evaluatorId}`,
      });
    }
  }
  const requiredEvidenceEvaluators = new Set(value.requiredEvidence.map((evidence) => evidence.evaluatorId));
  for (const requirement of value.expectedOutcome.requirements) {
    if (requirement.evaluation.kind === "deterministic") {
      if (!evaluatorIds.has(requirement.evaluation.evaluatorId)) {
        context.addIssue({
          code: "custom",
          path: ["expectedOutcome", "requirements"],
          message: `Requirement ${requirement.id} references unknown evaluator ${requirement.evaluation.evaluatorId}`,
        });
      } else if (!requiredEvidenceEvaluators.has(requirement.evaluation.evaluatorId)) {
        context.addIssue({
          code: "custom",
          path: ["requiredEvidence"],
          message: `Deterministic requirement ${requirement.id} has no required evidence`,
        });
      }
    } else if (!rubricIds.has(requirement.evaluation.rubricId)) {
      context.addIssue({
        code: "custom",
        path: ["expectedOutcome", "requirements"],
        message: `Requirement ${requirement.id} references unknown rubric ${requirement.evaluation.rubricId}`,
      });
    }
  }
  const assetIds = new Set(value.inputs.assets.map((asset) => asset.id));
  for (const turn of value.inputs.turns) {
    for (const assetId of turn.assetIds ?? []) {
      if (!assetIds.has(assetId)) {
        context.addIssue({
          code: "custom",
          path: ["inputs", "turns"],
          message: `Input turn references unknown asset ${assetId}`,
        });
      }
    }
  }
});

export type EvaluationCase = z.infer<typeof evaluationCaseSchema>;

export function parseEvaluationCase(value: unknown): EvaluationCase {
  const parsed = evaluationCaseSchema.safeParse(value);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid evaluation case: ${details}`);
  }
  return parsed.data;
}

export async function loadEvaluationCase(path: string): Promise<EvaluationCase> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not load evaluation case ${path}: ${message}`);
  }
  const parsed = parseEvaluationCase(value);
  const caseDirectory = resolve(path, "..");
  for (const asset of parsed.inputs.assets) {
    const assetPath = resolve(caseDirectory, asset.path);
    if (!assetPath.startsWith(`${caseDirectory}${sep}`)) {
      throw new Error(`Invalid evaluation case: asset ${asset.id} escapes the case directory`);
    }
    let bytes: Buffer;
    try {
      bytes = await readFile(assetPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid evaluation case: could not load asset ${asset.id}: ${message}`);
    }
    const actualHash = createHash("sha256").update(bytes).digest("hex");
    if (actualHash !== asset.sha256) {
      throw new Error(`Invalid evaluation case: asset ${asset.id} hash does not match declared sha256`);
    }
  }
  return parsed;
}
