import { describe, expect, it } from "vitest";
import type { DesignEscalationDto, ProofContractDto, SourceSpecificationDto } from "@chamfer/shared";
import type { DomainPlan, DomainPlanRevisionBatch } from "./domainPlan";
import {
  activeSpecificationConflict,
  designActionEscalationError,
  explicitRequirementWeakeningReasons,
  validateDesignEscalationRequest,
} from "./escalationPolicy";

const source = (id: string, requirement = id): SourceSpecificationDto => ({
  id,
  conversationId: "conversation",
  requirement,
  source: { messageId: "message", text: requirement, start: 0, end: requirement.length },
  actor: "agent",
  status: "active",
  timestamp: 1,
});

const width10 = { ...source("width-10"), conflictsWithSpecificationIds: ["width-12"] };
const width12 = { ...source("width-12"), conflictsWithSpecificationIds: ["width-10"] };

const plan: DomainPlan = {
  goal: "plate",
  components: [{
    id: "plate",
    description: "plate with four holes",
    status: "todo",
    bbox_mm: [30, 20, 4],
    free_floating_reason: "single part",
    checks: [
      { id: "holes", kind: "hole_through", diameter: 4, count: 4, target: "plate" },
      { id: "volume", kind: "volume", range_mm3: [2100, 2300], target: "plate" },
    ],
  }],
  interfaces: [],
  domain: {
    format: "domain-operations-v1",
    plan_id: "plan",
    revision: 1,
    criteria_revision: 1,
    source_specification_ids: ["holes-four"],
    requires_form_review: false,
    actor: "agent",
    created_at: 1,
    history: [],
  },
};

const explicit = source("holes-four", "The plate must have four holes.");
const contract: ProofContractDto = {
  contractId: "contract",
  conversationId: "conversation",
  revision: 1,
  status: "current",
  proofStatus: "pending",
  frozenAt: 1,
  derivation: {
    planId: "plan",
    planRevision: 1,
    criteriaRevision: 1,
    sourceSpecificationIds: [explicit.id],
    component: { id: "plate", description: "plate" },
    criteria: [{
      id: "specification:holes-four",
      category: "explicit-requirement",
      statement: explicit.requirement,
      sourceSpecificationId: explicit.id,
    }],
    plannedChecks: [],
    unavailableEvidence: [],
    invalidatedEvidenceIds: [],
    proofPolicy: { id: "proven-single-part-text", version: 1 },
    shapeProof: { status: "not-applicable", reason: "text" },
  },
};

describe("exception-based escalation policy", () => {
  it("detects active conflicts and blocks the affected workflow before a silent choice", () => {
    expect(activeSpecificationConflict([width10, width12])?.map((item) => item.id)).toEqual(["width-10", "width-12"]);
    expect(designActionEscalationError([width10, width12], [])).toContain("Conflicting active source requirements");
  });

  it("keeps a missing-scale or materially different interpretation pending and blocks deliverable actions", () => {
    for (const kind of ["missing-physical-scale", "materially-different-interpretations"] as const) {
      const escalation: DesignEscalationDto = {
        escalationId: kind,
        conversationId: "conversation",
        kind,
        question: kind === "missing-physical-scale" ? "What physical width should this reference represent?" : "Should the slot be open or blind?",
        affectedSpecificationIds: [],
        basis: "No evidence-backed default exists.",
        status: "pending",
        openedAt: 1,
        resolutionSpecificationIds: [],
      };
      expect(designActionEscalationError([], [escalation])).toContain(escalation.question);
      expect(validateDesignEscalationRequest(escalation, [], [], [])).toBeUndefined();
    }
  });

  it("blocks autonomous explicit-requirement weakening but permits tightening and source-backed recovery", () => {
    const weaken: DomainPlanRevisionBatch = {
      mutation_id: "weaken",
      reason: "Make the result easier.",
      operations: [{
        kind: "revise_check",
        component_id: "plate",
        check_id: "holes",
        check: { id: "holes", kind: "hole_through", diameter: 4, count: 2, target: "plate" },
      }],
    };
    expect(explicitRequirementWeakeningReasons(plan, weaken, [explicit], contract)).toContain(
      "check plate.holes count changed from 4 to 2",
    );

    const tighten: DomainPlanRevisionBatch = {
      mutation_id: "tighten",
      reason: "Tighten a construction-derived evidence range.",
      operations: [{
        kind: "revise_check",
        component_id: "plate",
        check_id: "volume",
        check: { id: "volume", kind: "volume", range_mm3: [2150, 2250], target: "plate" },
      }],
    };
    expect(explicitRequirementWeakeningReasons(plan, tighten, [explicit], contract)).toEqual([]);

    const answered = { ...source("holes-two"), supersedesSpecificationIds: [explicit.id] };
    expect(explicitRequirementWeakeningReasons(plan, weaken, [answered], contract)).toEqual([]);
  });

  it("does not interrupt documented construction choices or conservative defaults", () => {
    expect(designActionEscalationError([explicit], [])).toBeUndefined();
    expect(validateDesignEscalationRequest({
      escalationId: "routine-confirmation",
      kind: "explicit-requirement-change",
      question: "May I use a standard fillet?",
      affectedSpecificationIds: [explicit.id],
      basis: "This is only a construction choice.",
    }, [explicit], [], [])).toContain("no blocked explicit-requirement weakening");
  });
});
