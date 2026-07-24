import { describe, expect, it } from "vitest";
import {
  evidenceProjection,
  planGate,
  proofContractFreshnessGate,
  visualCoverageGate,
  type EvidenceEvent,
} from "./evidence";

const conversationId = "conversation-1";

function event<T extends EvidenceEvent["type"]>(
  sequence: number,
  type: T,
  data: Extract<EvidenceEvent, { type: T }>["data"],
): Extract<EvidenceEvent, { type: T }> {
  return {
    id: `event-${sequence}`,
    conversationId,
    sequence,
    recordedAt: sequence * 100,
    type,
    data,
  } as Extract<EvidenceEvent, { type: T }>;
}

describe("evidenceProjection", () => {
  it("keeps a proof contract current across operational plan revisions with unchanged criteria", () => {
    const plan = (revision: number) => ({
      domain: { plan_id: "plan-1", revision, criteria_revision: 1 },
      goal: "Build one plate",
      components: [],
      interfaces: [],
    });
    const contract = {
      contractId: "contract-1",
      conversationId,
      revision: 1,
      status: "current" as const,
      proofStatus: "pending" as const,
      frozenAt: 200,
      derivation: {
        planId: "plan-1",
        planRevision: 1,
        criteriaRevision: 1,
        sourceSpecificationIds: ["requirement-1"],
        component: { id: "plate", description: "Plate" },
        criteria: [],
        plannedChecks: [],
        unavailableEvidence: [],
        invalidatedEvidenceIds: [],
        proofPolicy: { id: "proven-single-part-text" as const, version: 1 as const },
        shapeProof: { status: "not-applicable" as const, reason: "Text-only design." },
      },
    };
    const projection = evidenceProjection([
      event(1, "plan.recorded", { operation: "created", plan: plan(1) }),
      event(2, "proof-contract.frozen", { contract }),
      event(3, "plan.recorded", { operation: "revised", plan: plan(2) }),
    ]);

    expect(projection.proofContracts).toEqual([contract]);
    expect(proofContractFreshnessGate(projection, "plan-1", 1)).toEqual({ passed: true });
  });

  it("replays one immutable history into deterministic current rigor state", () => {
    const events: EvidenceEvent[] = [
      event(1, "plan.recorded", {
        operation: "created",
        plan: { id: "plan-1", revision: 1, components: [] },
        checkChanges: [{
          componentId: "body",
          checkId: "width",
          kind: "changed",
          before: { description: "Width is approximately 20 mm." },
          after: { description: "Width is exactly 20 mm." },
        }],
      }),
      event(2, "source-specifications.recorded", {
        specifications: [{
          id: "width-v1",
          requirement: "Width is 20 mm.",
          source: { messageId: "message-1", text: "Width is 20 mm.", start: 0, end: 15 },
          conversationId,
          actor: "agent",
          status: "active",
          timestamp: 200,
        }],
      }),
      event(3, "source-specifications.recorded", {
        specifications: [{
          id: "width-v2",
          requirement: "Width is 22 mm.",
          source: { messageId: "message-2", text: "Width is 22 mm.", start: 0, end: 15 },
          supersedesSpecificationId: "width-v1",
          conversationId,
          actor: "agent",
          status: "active",
          timestamp: 300,
        }],
      }),
      event(4, "proof-contract.frozen", {
        contract: {
          contractId: "contract-1",
          conversationId,
          revision: 1,
          status: "current",
          proofStatus: "pending",
          frozenAt: 400,
          derivation: {
            planId: "plan-1",
            planRevision: 1,
            criteriaRevision: 1,
            sourceSpecificationIds: ["width-v2"],
            component: { id: "body", description: "Body" },
            criteria: [],
            plannedChecks: [],
            unavailableEvidence: [],
            invalidatedEvidenceIds: [],
            proofPolicy: { id: "proven-single-part-text", version: 1 },
            shapeProof: { status: "not-applicable", reason: "Text-only design." },
          },
        },
      }),
      event(5, "visual-comparison.recorded", {
        comparison: {
          evidenceId: "comparison-1",
          status: "not-applicable",
          policy: { id: "test-policy", version: 1 },
          algorithm: { id: "test-algorithm", version: 1 },
          thresholds: { silhouetteOverlapMin: 0.9, edgeAlignmentMin: 0.9, edgeTolerancePx: 1 },
          candidate: { artifactId: "artifact-1", artifactVersion: 1, inspectionSheetId: "sheet-1" },
          comparisons: [],
        },
      }),
      event(6, "visual-verification.recorded", {
        verification: {
          id: "visual-1",
          conversationId,
          artifactId: "artifact-1",
          artifactVersion: 1,
          inspectionSheetId: "sheet-1",
          visualComparisonEvidenceId: "comparison-1",
          coveredReferenceIds: ["reference-1"],
          verdict: "match",
          observations: [],
          recordedAt: 500,
        },
      }),
      event(7, "verification-checks.revision-attempted", {
        attempt: {
          attemptId: "attempt-1",
          planId: "plan-1",
          priorContractId: "contract-1",
          priorContractRevision: 1,
          proposedCriteriaRevision: 2,
          proposedChecks: [],
          comparison: { verdict: "loosen", checks: [] },
          status: "held",
          reason: "volume range widened",
          attemptedAt: 700,
        },
      }),
    ];

    const first = evidenceProjection(events);
    const replayed = evidenceProjection(JSON.parse(JSON.stringify(events)) as EvidenceEvent[]);
    const incrementallyProjected = events.reduce(
      (projection, item) => evidenceProjection([item], projection),
      undefined as ReturnType<typeof evidenceProjection> | undefined,
    );

    expect(replayed).toEqual(first);
    expect(incrementallyProjected).toEqual(first);
    expect(first.activePlan).toEqual({ id: "plan-1", revision: 1, components: [] });
    expect(first.planCheckChanges).toEqual([{
      componentId: "body",
      checkId: "width",
      kind: "changed",
      before: { description: "Width is approximately 20 mm." },
      after: { description: "Width is exactly 20 mm." },
    }]);
    expect(first.sourceSpecifications.map((item) => [item.id, item.status])).toEqual([
      ["width-v1", "superseded"],
      ["width-v2", "active"],
    ]);
    expect(first.sourceSpecifications[0]?.supersededBySpecificationId).toBe("width-v2");
    expect(first.events).toEqual(events);
    expect(first.verificationCheckRevisionAttempts).toEqual([
      expect.objectContaining({ attemptId: "attempt-1", status: "held" }),
    ]);
    expect(planGate(first)).toEqual({ passed: true });
    expect(proofContractFreshnessGate(first, "plan-1", 1)).toEqual({ passed: true });
    expect(visualCoverageGate(first, {
      artifactId: "artifact-1",
      artifactVersion: 1,
      inspectionSheetId: "sheet-1",
      activeReferenceIds: ["reference-1"],
    })).toEqual({ passed: true });
  });

  it("fails gates with reproducible reasons derived only from recorded events", () => {
    const projection = evidenceProjection([]);

    expect(planGate(projection)).toEqual({ passed: false, reason: "no active plan is recorded" });
    expect(proofContractFreshnessGate(projection, "plan-1", 1)).toEqual({
      passed: false,
      reason: "no current proof contract covers plan plan-1 criteria revision 1",
    });
    expect(visualCoverageGate(projection, {
      artifactId: "artifact-1",
      artifactVersion: 1,
      inspectionSheetId: "sheet-1",
      activeReferenceIds: ["reference-1"],
    })).toEqual({
      passed: false,
      reason: "no matching visual verification covers the current artifact, inspection sheet, and active references",
    });
  });

  it("accepts an initial-candidate visual review without a baseline but fails closed once a baseline exists", () => {
    const verification = {
      id: "visual-1",
      conversationId,
      artifactId: "artifact-1",
      artifactVersion: 1,
      inspectionSheetId: "sheet-1",
      visualComparisonEvidenceId: "comparison-1",
      coveredReferenceIds: ["reference-1"],
      verdict: "match" as const,
      observations: [],
      recordedAt: 200,
    };
    const comparison = {
      evidenceId: "comparison-1",
      status: "not-applicable" as const,
      policy: { id: "test-policy", version: 1 },
      algorithm: { id: "test-algorithm", version: 1 },
      thresholds: { silhouetteOverlapMin: 0.9, edgeAlignmentMin: 0.9, edgeTolerancePx: 1 },
      candidate: { artifactId: "artifact-1", artifactVersion: 1, inspectionSheetId: "sheet-1" },
      comparisons: [],
      reason: "The initial design working candidate establishes the accepted render baseline.",
    };
    const target = {
      artifactId: "artifact-1",
      artifactVersion: 1,
      inspectionSheetId: "sheet-1",
      activeReferenceIds: ["reference-1"],
    };

    const firstRevision = evidenceProjection([
      event(1, "visual-comparison.recorded", { comparison }),
      event(2, "visual-verification.recorded", { verification }),
    ]);
    expect(visualCoverageGate(firstRevision, target)).toEqual({ passed: true });

    const failedMeasurement = evidenceProjection([
      event(1, "visual-comparison.recorded", {
        comparison: {
          ...comparison,
          status: "unavailable",
          comparisons: [{
            target: { kind: "prior-accepted-artifact", id: "artifact-0:1" },
            status: "unavailable",
            views: [],
            reason: "Stored baseline could not be decoded.",
          }],
        },
      }),
      event(2, "visual-verification.recorded", { verification }),
    ]);
    expect(visualCoverageGate(failedMeasurement, target)).toEqual({
      passed: false,
      reason: "current measured visual comparison is unavailable for an existing baseline",
    });

    const mismatchedBaseline = evidenceProjection([
      event(1, "visual-comparison.recorded", {
        comparison: {
          ...comparison,
          status: "mismatch",
          comparisons: [{
            target: { kind: "prior-accepted-artifact", id: "artifact-0:1" },
            status: "mismatch",
            views: [],
          }],
        },
      }),
      event(2, "visual-verification.recorded", { verification }),
    ]);
    expect(visualCoverageGate(mismatchedBaseline, target)).toEqual({
      passed: false,
      reason: "current measured visual comparison does not match the existing baseline",
    });
  });

  it("does not let malformed plans or mismatch verdicts satisfy gates", () => {
    const projection = evidenceProjection([
      event(1, "plan.recorded", { operation: "created", plan: {} }),
      event(2, "visual-verification.recorded", {
        verification: {
          id: "visual-mismatch",
          conversationId,
          artifactId: "artifact-1",
          artifactVersion: 1,
          inspectionSheetId: "sheet-1",
          visualComparisonEvidenceId: "missing-comparison",
          coveredReferenceIds: ["reference-1"],
          verdict: "needs-revision",
          observations: [],
          recordedAt: 200,
        },
      }),
    ]);

    expect(planGate(projection).passed).toBe(false);
    expect(visualCoverageGate(projection, {
      artifactId: "artifact-1",
      artifactVersion: 1,
      inspectionSheetId: "sheet-1",
      activeReferenceIds: ["reference-1"],
    }).passed).toBe(false);
  });

  it("keeps registrations current when an active reference becomes complementary", () => {
    const registration = {
      registrationId: "registration-1",
      conversationId,
      referenceId: "reference-1",
      revision: 1,
      status: "current" as const,
      sourceRegion: { x: 0, y: 0, width: 1, height: 1 },
      projection: "perspective" as const,
      visibleLandmarks: [],
      uncertainty: { level: "low" as const, notes: "", occluded: false },
      geometry: {
        sourceSizePx: { width: 10, height: 10 },
        regionPx: { x: 0, y: 0, width: 10, height: 10 },
        extraction: {
          status: "failed" as const,
          reason: "Not required for this replay test.",
          extractor: { id: "opencv-js-contour" as const, version: 1 },
        },
      },
      eligibility: { status: "advisory" as const, reasons: ["Perspective projection."] },
      timestamp: 100,
    };
    const projection = evidenceProjection([
      event(1, "reference.classified", {
        attachmentAvailable: true,
        classification: {
          id: "classification-active",
          conversationId,
          referenceId: "reference-1",
          status: "active",
          purpose: "Primary view",
          relationships: [],
          rationale: "Defines the design.",
          specificationIds: [],
          specificationLinks: [],
          noSpecificationReason: "No extractable dimension.",
          actor: "agent",
          timestamp: 100,
        },
      }),
      event(2, "reference.registered", { registration }),
      event(3, "reference.classified", {
        attachmentAvailable: true,
        classification: {
          id: "classification-complementary",
          conversationId,
          referenceId: "reference-1",
          status: "complementary",
          purpose: "Supporting view",
          relationships: [],
          rationale: "Still contributes evidence.",
          specificationIds: [],
          specificationLinks: [],
          noSpecificationReason: "No extractable dimension.",
          actor: "agent",
          timestamp: 300,
        },
      }),
    ]);

    expect(projection.referenceRegistrations).toEqual([registration]);
  });
});
