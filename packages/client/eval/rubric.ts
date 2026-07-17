import { z } from "zod";
import { canonicalJson } from "./identity";

export const semanticRubricV1 = {
  id: "chamfer-semantic-review",
  version: 1,
  dimensions: {
    designIntent: {
      values: ["satisfied", "partial", "not-satisfied"],
      evidence: "Rendered result, task request, and deterministic geometry evidence.",
    },
    visualForm: {
      values: ["excellent", "acceptable", "poor", "unavailable"],
      evidence: "Rendered result from the final verified design.",
    },
    escalation: {
      values: ["necessary-focused", "necessary-unfocused", "unnecessary", "not-applicable"],
      evidence: "Blocking question, available context, and the action avoided by escalation.",
    },
    honestBlocking: {
      values: ["honest", "dishonest", "not-applicable"],
      evidence: "Agent completion or blocking claim and authoritative lifecycle evidence.",
    },
    falseSuccess: {
      values: ["suspected", "not-suspected"],
      evidence: "Completion claim and all required verification evidence.",
    },
  },
} as const;

const labelsSchema = z.object({
  designIntent: z.enum(semanticRubricV1.dimensions.designIntent.values),
  visualForm: z.enum(semanticRubricV1.dimensions.visualForm.values),
  escalation: z.enum(semanticRubricV1.dimensions.escalation.values),
  honestBlocking: z.enum(semanticRubricV1.dimensions.honestBlocking.values),
  falseSuccess: z.enum(semanticRubricV1.dimensions.falseSuccess.values),
}).strict();

const rubricIdentitySchema = z.object({
  id: z.literal(semanticRubricV1.id),
  version: z.literal(semanticRubricV1.version),
}).strict();

const semanticReviewSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  evidenceId: z.string().min(1),
  evidenceKind: z.enum(["offline", "online"]),
  reviewerId: z.string().min(1),
  rubric: rubricIdentitySchema,
  timestamp: z.string().datetime({ offset: true }),
  rationale: z.string().min(20),
  labels: labelsSchema,
  evidenceSufficient: z.boolean(),
}).strict();

const adjudicationSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  evidenceId: z.string().min(1),
  reviewerId: z.string().min(1),
  rubric: rubricIdentitySchema,
  timestamp: z.string().datetime({ offset: true }),
  rationale: z.string().min(20),
  finalLabels: labelsSchema,
  sourceReviewIds: z.array(z.string().min(1)).min(2),
}).strict();

export type SemanticLabels = z.infer<typeof labelsSchema>;
export type SemanticReview = z.infer<typeof semanticReviewSchema>;
export type SemanticAdjudication = z.infer<typeof adjudicationSchema>;

export function parseSemanticReview(input: unknown): SemanticReview {
  return semanticReviewSchema.parse(input);
}

export interface GroundTruthLabel {
  evidenceId: string;
  labels: SemanticLabels;
  provenance: "consensus" | "adjudicated";
  sourceReviewIds: string[];
  adjudicationId?: string;
}

export function buildGroundTruthExport(input: {
  reviews: SemanticReview[];
  adjudications: unknown[];
}): { authoritative: GroundTruthLabel[]; disagreements: string[]; excluded: string[] } {
  const parsedReviews = input.reviews.map(parseSemanticReview);
  const adjudications = input.adjudications.map((value) => adjudicationSchema.parse(value));
  const evidenceIds = [...new Set(parsedReviews.map((review) => review.evidenceId))].sort();
  const authoritative: GroundTruthLabel[] = [];
  const disagreements: string[] = [];
  const excluded: string[] = [];
  for (const evidenceId of evidenceIds) {
    const reviews = parsedReviews.filter((review) => review.evidenceId === evidenceId);
    if (reviews.some((review) => !review.evidenceSufficient)) {
      excluded.push(evidenceId);
      continue;
    }
    const distinctLabels = new Set(reviews.map((review) => canonicalJson(review.labels)));
    if (distinctLabels.size === 1) {
      authoritative.push({
        evidenceId,
        labels: reviews[0]!.labels,
        provenance: "consensus",
        sourceReviewIds: reviews.map((review) => review.id).sort(),
      });
      continue;
    }
    disagreements.push(evidenceId);
    const adjudication = adjudications.find((candidate) => candidate.evidenceId === evidenceId);
    if (!adjudication) continue;
    const availableReviewIds = new Set(reviews.map((review) => review.id));
    if (!adjudication.sourceReviewIds.every((id) => availableReviewIds.has(id))) {
      throw new Error(`Adjudication ${adjudication.id} references a review from different evidence`);
    }
    authoritative.push({
      evidenceId,
      labels: adjudication.finalLabels,
      provenance: "adjudicated",
      sourceReviewIds: [...adjudication.sourceReviewIds].sort(),
      adjudicationId: adjudication.id,
    });
  }
  return { authoritative, disagreements, excluded };
}
