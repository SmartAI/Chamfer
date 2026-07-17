import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { loadEvaluationCase } from "./schema";
import { assertPromotionSyncCompatible, promoteReviewedFailure } from "./promotion";

const requiredApprovals = ["case-version", "corpus-inclusion", "category", "complexity", "gating-status"] as const;

describe("privacy-safe failure promotion", () => {
  it("creates a synthetic proposal without retaining a production-session link", async () => {
    const evaluationCase = await loadEvaluationCase(resolve(import.meta.dirname, "cases/v1/precise-box.case.json"));
    const proposal = promoteReviewedFailure({
      reviewedFailure: {
        id: "reviewed-failure-1",
        scoreProvenance: "human-adjudicated-v1",
        evidenceSufficient: true,
        taxonomyCategory: "verification.false-success",
        behavioralClass: "Claims completion after the authoritative geometry gate rejects the result.",
        reproductionProperties: ["verification gate rejects geometry", "assistant emits a completion claim"],
      },
      evaluationCase,
      approvals: requiredApprovals.map((scope) => ({ scope, reviewerId: `reviewer-${scope}` })),
      existingFingerprints: [],
    });
    expect(proposal.provenance).toEqual({
      category: "reviewed-production-failure-class",
      taxonomyCategory: "verification.false-success",
    });
    expect(JSON.stringify(proposal)).not.toContain("reviewed-failure-1");
    expect(proposal.privacy.status).toBe("passed");
  });

  it("rejects unsafe source payloads and near-duplicate failure coverage", async () => {
    const evaluationCase = await loadEvaluationCase(resolve(import.meta.dirname, "cases/v1/precise-box.case.json"));
    const base = {
      reviewedFailure: {
        id: "reviewed-failure-1",
        scoreProvenance: "human-adjudicated-v1",
        evidenceSufficient: true,
        taxonomyCategory: "verification.false-success",
        behavioralClass: "Claims completion after the authoritative geometry gate rejects the result.",
        reproductionProperties: ["gate rejects", "completion is claimed"],
      },
      evaluationCase,
      approvals: requiredApprovals.map((scope) => ({ scope, reviewerId: `reviewer-${scope}` })),
      existingFingerprints: [] as string[],
    };
    expect(() => promoteReviewedFailure({
      ...base,
      reviewedFailure: { ...base.reviewedFailure, rawProductionConversation: "private text" } as never,
    })).toThrow();
    const first = promoteReviewedFailure(base);
    expect(() => promoteReviewedFailure({ ...base, existingFingerprints: [first.failureFingerprint] })).toThrow(
      /duplicate/i,
    );
  });

  it("allows idempotent synchronization but rejects historical meaning conflicts", async () => {
    const evaluationCase = await loadEvaluationCase(resolve(import.meta.dirname, "cases/v1/precise-box.case.json"));
    expect(() => assertPromotionSyncCompatible(evaluationCase, evaluationCase)).not.toThrow();
    expect(() => assertPromotionSyncCompatible(evaluationCase, {
      ...evaluationCase,
      purpose: `${evaluationCase.purpose} changed`,
    })).toThrow(/historical meaning/i);
  });
});
