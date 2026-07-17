import { z } from "zod";
import { canonicalJson, sha256Identity } from "./identity";
import { scanPrivacy, type PrivacyScan } from "./privacy";
import { evaluationCaseSchema, type EvaluationCase } from "./schema";

const reviewedFailureSchema = z.object({
  id: z.string().min(1),
  scoreProvenance: z.string().min(1),
  evidenceSufficient: z.literal(true),
  taxonomyCategory: z.string().regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/),
  behavioralClass: z.string().min(20),
  reproductionProperties: z.array(z.string().min(5)).min(1),
}).strict();

const approvalScope = z.enum([
  "case-version",
  "corpus-inclusion",
  "category",
  "complexity",
  "gating-status",
]);

const approvalSchema = z.object({
  scope: approvalScope,
  reviewerId: z.string().min(1),
}).strict();

type ApprovalScope = z.infer<typeof approvalScope>;

const requiredApprovals: ApprovalScope[] = [
  "case-version",
  "corpus-inclusion",
  "category",
  "complexity",
  "gating-status",
];

export interface FailurePromotion {
  schemaVersion: 1;
  failureFingerprint: string;
  provenance: {
    category: "reviewed-production-failure-class";
    taxonomyCategory: string;
  };
  behavioralClass: string;
  reproductionProperties: string[];
  scoreProvenance: string;
  evaluationCase: EvaluationCase;
  approvals: Array<{ scope: ApprovalScope; reviewerId: string }>;
  privacy: PrivacyScan;
}

export function promoteReviewedFailure(input: {
  reviewedFailure: unknown;
  evaluationCase: unknown;
  approvals: unknown[];
  existingFingerprints: string[];
}): FailurePromotion {
  const failure = reviewedFailureSchema.parse(input.reviewedFailure);
  const evaluationCase = evaluationCaseSchema.parse(input.evaluationCase);
  if (evaluationCase.sourceSafety.containsProductionData !== false) {
    throw new Error("Promoted cases must not contain production data");
  }
  const approvals = input.approvals.map((approval) => approvalSchema.parse(approval));
  const scopes = new Set(approvals.map((approval) => approval.scope));
  const missing = requiredApprovals.filter((scope) => !scopes.has(scope));
  if (missing.length > 0) throw new Error(`Failure promotion lacks review for ${missing.join(", ")}`);
  const reproductionProperties = [...failure.reproductionProperties].sort();
  const failureFingerprint = sha256Identity({
    taxonomyCategory: failure.taxonomyCategory,
    behavioralClass: failure.behavioralClass,
    reproductionProperties,
  });
  if (input.existingFingerprints.includes(failureFingerprint)) {
    throw new Error("Duplicate failure promotion adds no new behavioral coverage");
  }
  const publicProposal = {
    schemaVersion: 1 as const,
    failureFingerprint,
    provenance: {
      category: "reviewed-production-failure-class" as const,
      taxonomyCategory: failure.taxonomyCategory,
    },
    behavioralClass: failure.behavioralClass,
    reproductionProperties,
    scoreProvenance: failure.scoreProvenance,
    evaluationCase,
    approvals,
  };
  const privacy = scanPrivacy([{ source: `${evaluationCase.id}.promotion.json`, content: canonicalJson(publicProposal) }]);
  if (privacy.status === "failed") throw new Error("Failure promotion failed privacy validation");
  return { ...publicProposal, privacy };
}

export function assertPromotionSyncCompatible(existing: EvaluationCase, proposed: EvaluationCase): void {
  if (existing.id !== proposed.id || existing.version !== proposed.version) return;
  if (canonicalJson(existing) !== canonicalJson(proposed)) {
    throw new Error(`Promotion would overwrite historical meaning for ${existing.id}@${existing.version}`);
  }
}
