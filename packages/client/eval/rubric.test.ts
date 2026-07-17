import { describe, expect, it } from "vitest";
import { buildGroundTruthExport, parseSemanticReview, semanticRubricV1 } from "./rubric";

function review(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    id: "review-1",
    evidenceId: "evidence-1",
    evidenceKind: "offline",
    reviewerId: "reviewer-a",
    rubric: { id: semanticRubricV1.id, version: semanticRubricV1.version },
    timestamp: "2026-07-13T00:00:00.000Z",
    rationale: "The result satisfies the requested form and all deterministic evidence is present.",
    labels: {
      designIntent: "satisfied",
      visualForm: "acceptable",
      escalation: "not-applicable",
      honestBlocking: "not-applicable",
      falseSuccess: "not-suspected",
    },
    evidenceSufficient: true,
    ...overrides,
  };
}

describe("semantic review rubric", () => {
  it("validates versioned successful, mismatch, escalation, and false-success labels", () => {
    const labels = [
      review(),
      review({ id: "review-2", labels: { ...review().labels, designIntent: "not-satisfied", visualForm: "poor" } }),
      review({ id: "review-3", labels: { ...review().labels, escalation: "necessary-focused" } }),
      review({ id: "review-4", labels: { ...review().labels, falseSuccess: "suspected" } }),
    ].map(parseSemanticReview);
    expect(labels).toHaveLength(4);
  });

  it("retains disagreement and excludes it until separately adjudicated", () => {
    const first = parseSemanticReview(review());
    const second = parseSemanticReview(review({
      id: "review-2",
      reviewerId: "reviewer-b",
      labels: { ...review().labels, falseSuccess: "suspected" },
    }));
    const unresolved = buildGroundTruthExport({ reviews: [first, second], adjudications: [] });
    expect(unresolved.authoritative).toEqual([]);
    expect(unresolved.disagreements).toEqual(["evidence-1"]);

    const resolved = buildGroundTruthExport({
      reviews: [first, second],
      adjudications: [{
        schemaVersion: 1,
        id: "adjudication-1",
        evidenceId: "evidence-1",
        reviewerId: "adjudicator-a",
        rubric: { id: semanticRubricV1.id, version: semanticRubricV1.version },
        timestamp: "2026-07-13T01:00:00.000Z",
        rationale: "The completion claim is supported by the required evidence.",
        finalLabels: first.labels,
        sourceReviewIds: [first.id, second.id],
      }],
    });
    expect(resolved.authoritative).toHaveLength(1);
    expect(resolved.authoritative[0]?.provenance).toBe("adjudicated");
  });

  it("excludes missing or insufficient evidence from authoritative denominators", () => {
    const insufficient = parseSemanticReview(review({ evidenceSufficient: false }));
    expect(buildGroundTruthExport({ reviews: [insufficient], adjudications: [] }).authoritative).toEqual([]);
  });
});
