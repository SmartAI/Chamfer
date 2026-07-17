import { describe, expect, it } from "vitest";
import type { ProofContractDto, ReferenceRegistrationDto, ShapeProofRecord, SourceSpecificationDto } from "@chamfer/shared";
import { applyDomainPlanRevision, createDomainPlan, type DomainPlanEnvironment } from "./domainPlan";
import {
  currentProofContract,
  deriveReferenceProofContract,
  deriveTextProofContract,
  proofContractPreflightError,
  proofFinalizationPreflightError,
  proofRunIdentityErrors,
} from "./proofContract";
import { collectComponentEvidence, harnessCheckForm } from "./plan";

const environment: DomainPlanEnvironment = {
  actor: "agent",
  now: () => 100,
  id: (kind) => `${kind}-stable`,
};

const specification: SourceSpecificationDto = {
  id: "plate-size",
  conversationId: "conversation-1",
  requirement: "The plate must be 30 x 20 x 4 mm.",
  source: { messageId: "message-1", text: "30 x 20 x 4 mm", start: 8, end: 23 },
  actor: "agent",
  status: "active",
  timestamp: 1,
};

function plan() {
  return createDomainPlan({
    goal: "mounting plate",
    components: [{
      id: "plate",
      description: "rectangular mounting plate",
      bbox_mm: [30, 20, 4],
      checks: [
        { id: "envelope", kind: "bbox", size_mm: [30, 20, 4], target: "plate" },
        { id: "volume", kind: "volume", range_mm3: [2200, 2600], target: "plate" },
      ],
      status: "todo",
      free_floating_reason: "single part",
    }],
    interfaces: [],
  }, {
    mutation_id: "create",
    reason: "initial criteria",
    source_specification_ids: [specification.id],
  }, new Map(), environment);
}

function frozen(currentPlan = plan()): ProofContractDto {
  return {
    contractId: "contract-1",
    conversationId: "conversation-1",
    revision: 1,
    status: "current",
    proofStatus: "pending",
    frozenAt: 100,
    derivation: deriveTextProofContract(currentPlan, [specification])!.derivation,
  };
}

const imageSpecification: SourceSpecificationDto = {
  ...specification,
  source: { attachmentId: "image-1", observation: "The front width is 30 mm." },
};

function registration(revision = 1): ReferenceRegistrationDto {
  return {
    registrationId: "registration-1",
    conversationId: "conversation-1",
    revision,
    status: "current",
    referenceId: "image-1",
    sourceRegion: { x: 0, y: 0, width: 1, height: 1 },
    projection: "orthographic",
    direction: "front",
    scaleAnchor: {
      specificationId: "plate-size",
      start: { x: 0.1, y: 0.9 },
      end: { x: 0.9, y: 0.9 },
      physicalLengthMm: 30,
    },
    visibleLandmarks: [],
    uncertainty: { level: "low", notes: "clear", occluded: false },
    geometry: {
      sourceSizePx: { width: 100, height: 100 },
      regionPx: { x: 0, y: 0, width: 100, height: 100 },
      extraction: { status: "succeeded", extractor: { id: "opencv-js-contour", version: 1 } },
      mask: { width: 100, height: 100, rle: [0, 10_000] },
      contour: { points: [[1, 1], [98, 1], [98, 98], [1, 98]], areaPx2: 9_409 },
      scaleTransform: { specificationId: "plate-size", physicalLengthMm: 30, pixelLength: 80, mmPerPixel: 0.375 },
    },
    eligibility: { status: "eligible", reasons: [] },
    timestamp: 10,
  };
}

function shapeRun(contract: ProofContractDto, status: ShapeProofRecord["status"]) {
  return {
    role: "toolResult",
    toolName: "run_build123d",
    details: {
      measurements: { component: "plate" },
      code: { artifactId: "artifact-1", artifactVersion: 1 },
      shapeProof: {
        status,
        evaluator: { id: "orthographic-mask-and-landmark-comparison", version: 1 },
        policy: { id: "multi-view-shape-proof", version: 1 },
        contract: { id: contract.contractId, revision: contract.revision, criteriaRevision: contract.derivation.criteriaRevision },
        coverage: {
          activeReferenceIds: ["image-1"],
          requiredRegistrationIds: ["registration-1"],
          batches: [["registration-1"]],
        },
        views: [{
          status,
          registration: { id: "registration-1", revision: 1, referenceId: "image-1", direction: "front" },
          render: {},
          thresholds: {
            silhouetteIouMin: 0.99,
            symmetricContourDistanceMmMax: 0.75,
            landmarkPositionErrorMmMax: 0.75,
            sourceResolutionMm: 0.375,
          },
          ...(status === "error" ? {} : {
            metrics: {
              silhouetteIou: status === "passed" ? 1 : 0.8,
              symmetricContourDistanceMm: status === "passed" ? 0 : 1,
              landmarks: [],
            },
          }),
          worst: { metric: status === "error" ? "evaluation" : "silhouette-iou", detail: "silhouette mismatch" },
        }],
        registration: { id: "registration-1", revision: 1, referenceId: "image-1", direction: "front" },
        artifact: { id: "artifact-1", version: 1 },
        render: {},
        thresholds: {
          silhouetteIouMin: 0.99,
          symmetricContourDistanceMmMax: 0.75,
          landmarkPositionErrorMmMax: 0.75,
          sourceResolutionMm: 0.375,
        },
        ...(status === "error" ? {} : {
          metrics: {
            silhouetteIou: status === "passed" ? 1 : 0.8,
            symmetricContourDistanceMm: status === "passed" ? 0 : 1,
            landmarks: [],
          },
        }),
        worst: {
          metric: status === "error" ? "evaluation" : "silhouette-iou",
          detail: status === "passed" ? "Both independent shape metrics satisfy policy." : "silhouette mismatch",
        },
      } satisfies ShapeProofRecord,
    },
  };
}

describe("text proof contract", () => {
  it("derives categorized criteria, checks, assumptions, policy, and not-applicable shape proof", () => {
    const currentPlan = plan();
    currentPlan.spec_sheet = [{
      id: "finish",
      text: "The surface finish must be confirmed.",
      source: "text",
      unverifiable_reason: "Surface finish is not measurable from B-rep geometry.",
    }];
    const contract = deriveTextProofContract(currentPlan, [specification])!.derivation;
    expect(contract.criteria.map((criterion) => criterion.category)).toEqual([
      "explicit-requirement",
      "conservative-default",
      "conservative-default",
      "agent-assumption",
      "agent-assumption",
    ]);
    expect(contract.plannedChecks).toEqual([
      expect.objectContaining({ id: "envelope", kind: "bbox" }),
      expect.objectContaining({ id: "volume", kind: "volume" }),
    ]);
    expect(contract.shapeProof.status).toBe("not-applicable");
    expect(contract.sourceSpecificationIds).toEqual(["plate-size"]);
    expect(contract.unavailableEvidence).toEqual([{
      id: "finish",
      requirement: "The surface finish must be confirmed.",
      reason: "Surface finish is not measurable from B-rep geometry.",
    }]);
  });

  it("exempts probes but blocks a deliverable until the current identity is frozen", () => {
    const currentPlan = plan();
    const probe = 'COMPONENT = "probe"\nresult = Box(1, 1, 1)';
    const deliverable = 'COMPONENT = "plate"\nresult = Box(30, 20, 4)';
    expect(proofContractPreflightError(currentPlan, [specification], [], probe)).toBeUndefined();
    expect(proofContractPreflightError(currentPlan, [specification], [], deliverable)).toContain("no current frozen proof contract");
    expect(proofContractPreflightError(currentPlan, [specification], [frozen(currentPlan)], deliverable)).toBeUndefined();
  });

  it("makes the old contract non-current after a criteria revision", () => {
    const original = plan();
    const runEvidence = collectComponentEvidence([{
      role: "toolResult",
      toolName: "run_build123d",
      toolCallId: "run-old",
      isError: false,
      details: {
        gate: { status: "passed", checks: [] },
        measurements: {
          component: "plate",
          checks: original.components[0]!.checks!.map(harnessCheckForm),
        },
        planConformance: {
          status: "passed",
          planId: original.domain.plan_id,
          componentCriteriaRevisions: { plate: 1 },
        },
      },
    }]);
    const completed = applyDomainPlanRevision(original, {
      mutation_id: "finish",
      reason: "the deliverable passed",
      operations: [{ kind: "set_component_status", component_id: "plate", status: "done" }],
    }, runEvidence, environment);
    const revised = applyDomainPlanRevision(completed, {
      mutation_id: "revise",
      reason: "tighten the planned envelope",
      operations: [{
        kind: "revise_component",
        component_id: "plate",
        bbox_mm: [30, 20, 5],
      }],
    }, runEvidence, environment);
    expect(revised.domain.criteria_revision).toBe(2);
    expect(currentProofContract([frozen(completed)], revised)).toBeUndefined();
    expect(deriveTextProofContract(revised, [specification])!.derivation.invalidatedEvidenceIds).toEqual(["run-old"]);
  });

  it("is ineligible for image-derived or multi-component plans", () => {
    expect(deriveTextProofContract(plan(), [imageSpecification])).toBeUndefined();
    const multi = plan();
    multi.components.push({ id: "cap", description: "cap", status: "todo" });
    expect(deriveTextProofContract(multi, [specification])).toBeUndefined();
  });

  it("requires plan, contract, declaration, result label, and kernel integrity to share one identity", () => {
    const currentPlan = plan();
    const contract = frozen(currentPlan);
    expect(proofRunIdentityErrors(currentPlan, contract, {
      component: "plate",
      integrity: {
        status: "conforming",
        componentId: "plate",
        resultLabel: "plate",
        solidCount: 1,
        valid: true,
        issues: [],
      },
    })).toEqual([]);

    expect(proofRunIdentityErrors(currentPlan, contract, {
      component: "housing",
      integrity: {
        status: "conforming",
        componentId: "housing",
        resultLabel: "housing",
        solidCount: 1,
        valid: true,
        issues: [],
      },
    }).join("\n")).toContain("plate");
  });

  it("blocks Proven Single Part completion with multiple active components without changing ordinary multi-part plans", () => {
    const currentPlan = plan();
    const contract = frozen(currentPlan);
    const multi = plan();
    multi.components.push({ id: "cap", description: "cap", status: "todo" });
    const operations = [{ kind: "set_component_status", component_id: "plate", status: "done" }];

    expect(proofFinalizationPreflightError(multi, [contract], operations)).toContain("2 active deliverable components");
    expect(proofFinalizationPreflightError(multi, [], operations)).toBeUndefined();
  });

  it("binds image proof to the exact eligible registration revision and invalidates it on change", () => {
    const currentPlan = plan();
    const firstRegistration = registration(1);
    const derivation = deriveReferenceProofContract(currentPlan, [imageSpecification], [firstRegistration])!.derivation;
    expect(derivation.shapeProof).toMatchObject({
      status: "required",
      registrations: [{ registrationId: "registration-1", referenceId: "image-1", revision: 1, eligibility: "eligible" }],
    });
    const contract: ProofContractDto = {
      contractId: "reference-contract",
      conversationId: "conversation-1",
      revision: 1,
      status: "current",
      proofStatus: "pending",
      frozenAt: 20,
      derivation,
    };
    expect(currentProofContract([contract], currentPlan, [firstRegistration])).toEqual(contract);
    expect(currentProofContract([contract], currentPlan, [registration(2)])).toBeUndefined();
    const operations = [{ kind: "set_component_status", component_id: "plate", status: "done" }];
    expect(proofFinalizationPreflightError(currentPlan, [contract], operations, [firstRegistration], [shapeRun(contract, "passed")], ["image-1"])).toBeUndefined();
    expect(proofFinalizationPreflightError(currentPlan, [contract], operations, [firstRegistration], [shapeRun(contract, "failed")], ["image-1"]))
      .toContain("shape proof failed");
    expect(proofFinalizationPreflightError(currentPlan, [contract], operations, [firstRegistration], [shapeRun(contract, "error")], ["image-1"]))
      .toContain("shape proof error");
    expect(proofFinalizationPreflightError(currentPlan, [contract], operations, [firstRegistration], []))
      .toContain("no current independent shape-proof record");
    expect(proofFinalizationPreflightError(currentPlan, [contract], operations, [registration(2)]))
      .toContain("no current proof contract");
  });
});
