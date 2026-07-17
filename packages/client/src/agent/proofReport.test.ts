import { describe, expect, it } from "vitest";
import type { ProofContractDto, ProofReportDto, SourceSpecificationDto } from "@chamfer/shared";
import { TEXT_PROOF_POLICY } from "@chamfer/shared";
import {
  effectiveProofReport,
  proofReportInputForCurrentEvidence,
  proofReportInputFromRun,
} from "./proofReport";
import type { Plan } from "./plan";

const plan: Plan = {
  goal: "Build a plate",
  components: [{ id: "plate", description: "plate", status: "building", criteria_revision: 1 }],
  interfaces: [],
  domain: {
    format: "domain-operations-v1",
    plan_id: "plan-1",
    revision: 2,
    criteria_revision: 1,
    source_specification_ids: ["plate-size"],
    actor: "agent",
    created_at: 1,
    history: [],
  },
};

const specification: SourceSpecificationDto = {
  id: "plate-size",
  requirement: "30 mm plate",
  source: { messageId: "message-1", text: "30 mm", start: 0, end: 5 },
  conversationId: "conversation-1",
  actor: "agent",
  status: "active",
  timestamp: 1,
};

const contract: ProofContractDto = {
  contractId: "contract-1",
  conversationId: "conversation-1",
  revision: 1,
  status: "current",
  proofStatus: "pending",
  frozenAt: 2,
  derivation: {
    planId: "plan-1",
    planRevision: 1,
    criteriaRevision: 1,
    sourceSpecificationIds: ["plate-size"],
    component: { id: "plate", description: "plate" },
    criteria: [],
    plannedChecks: [],
    unavailableEvidence: [],
    invalidatedEvidenceIds: [],
    proofPolicy: TEXT_PROOF_POLICY,
    shapeProof: { status: "not-applicable", reason: "text only" },
  },
};

const report = {
  reportId: "report-1",
  conversationId: "conversation-1",
  createdAt: 4,
  status: "proven",
  proofContract: contract,
  acceptedPlan: { planId: "plan-1", revision: 2, criteriaRevision: 1, goal: "Build", componentId: "plate", snapshot: {} },
  sourceSpecifications: [specification],
  referenceRegistrations: [],
  cadArtifact: { id: "artifact-1", version: 1, createdAt: 3 },
  visualVerification: { state: "not-applicable", reason: "text only" },
} as unknown as ProofReportDto;

describe("text proof report identity", () => {
  it("derives a creation request only from a persisted run identity and current contract", () => {
    expect(proofReportInputFromRun({
      role: "toolResult",
      toolName: "run_build123d",
      toolCallId: "run-1",
      details: { code: { artifactId: "artifact-1", artifactVersion: 1 } },
    }, plan, contract)).toEqual({
      proofContractId: "contract-1",
      proofContractRevision: 1,
      planId: "plan-1",
      planRevision: 2,
      criteriaRevision: 1,
      artifactId: "artifact-1",
      artifactVersion: 1,
      engineeringEvidenceId: "run-1",
    });
  });

  it("waits for matching visual evidence and component completion after passing reference shape proof", () => {
    const referenceContract: ProofContractDto = {
      ...contract,
      derivation: {
        ...contract.derivation,
        proofPolicy: { id: "proven-single-part-reference", version: 1 },
        shapeProof: {
          status: "required",
          reason: "registered view is eligible",
          registrations: [{
            registrationId: "registration-1",
            referenceId: "reference-1",
            revision: 1,
            eligibility: "eligible",
          }],
        },
      },
    };
    const run = {
      role: "toolResult",
      toolName: "run_build123d",
      toolCallId: "run-reference",
      details: {
        code: { artifactId: "artifact-1", artifactVersion: 1 },
        shapeProof: { status: "passed" },
        inspectionSheet: { attachmentId: "sheet-1" },
      },
    };
    const visual = {
      id: "visual-1",
      conversationId: "conversation-1",
      artifactId: "artifact-1",
      artifactVersion: 1,
      inspectionSheetId: "sheet-1",
      coveredReferenceIds: ["reference-1"],
      verdict: "match" as const,
      observations: [],
      recordedAt: 5,
    };
    const donePlan: Plan = { ...plan, components: [{ ...plan.components[0]!, status: "done" }] };
    expect(proofReportInputForCurrentEvidence(run, [run], plan, referenceContract, undefined)).toBeUndefined();
    expect(proofReportInputForCurrentEvidence({
      role: "toolResult",
      toolName: "record_visual_verification_batch",
      isError: false,
    }, [run], plan, referenceContract, visual)).toBeUndefined();
    expect(proofReportInputForCurrentEvidence({
      role: "toolResult",
      toolName: "record_visual_verification_batch",
      isError: false,
    }, [run], donePlan, referenceContract, visual)).toMatchObject({
      engineeringEvidenceId: "run-reference",
      visualVerificationId: "visual-1",
    });
    expect(proofReportInputForCurrentEvidence({
      role: "toolResult",
      toolName: "revise_plan",
      isError: false,
    }, [run], donePlan, referenceContract, visual)).toMatchObject({
      engineeringEvidenceId: "run-reference",
      visualVerificationId: "visual-1",
    });
  });

  it("allows a failed reference shape report without mislabeling it as finalized", () => {
    const referenceContract: ProofContractDto = {
      ...contract,
      derivation: {
        ...contract.derivation,
        proofPolicy: { id: "proven-single-part-reference", version: 1 },
        shapeProof: {
          status: "required",
          reason: "registered view is eligible",
          registrations: [{
            registrationId: "registration-1",
            referenceId: "reference-1",
            revision: 1,
            eligibility: "eligible",
          }],
        },
      },
    };
    const failedRun = {
      role: "toolResult",
      toolName: "run_build123d",
      toolCallId: "run-failed-shape",
      details: {
        code: { artifactId: "artifact-1", artifactVersion: 1 },
        shapeProof: { status: "failed" },
        inspectionSheet: { attachmentId: "sheet-1" },
      },
    };
    expect(proofReportInputForCurrentEvidence(
      failedRun,
      [failedRun],
      plan,
      referenceContract,
      undefined,
    )).toMatchObject({ engineeringEvidenceId: "run-failed-shape" });
  });

  it("waits for visual evidence before reporting unavailable reference shape proof", () => {
    const referenceContract: ProofContractDto = {
      ...contract,
      derivation: {
        ...contract.derivation,
        proofPolicy: { id: "proven-single-part-reference", version: 1 },
        shapeProof: {
          status: "unavailable",
          reason: "registration is advisory",
          registrations: [{
            registrationId: "registration-1",
            referenceId: "reference-1",
            revision: 1,
            eligibility: "advisory",
          }],
        },
      },
    };
    const run = {
      role: "toolResult",
      toolName: "run_build123d",
      toolCallId: "run-unavailable-shape",
      details: {
        code: { artifactId: "artifact-1", artifactVersion: 1 },
        shapeProof: { status: "unavailable" },
        inspectionSheet: { attachmentId: "sheet-1" },
      },
    };
    expect(proofReportInputForCurrentEvidence(run, [run], plan, referenceContract, undefined)).toBeUndefined();
  });

  it.each([
    ["new artifact", { artifact: { id: "artifact-2", version: 2 } }],
    ["criteria revision", { plan: { ...plan, domain: { ...plan.domain!, criteria_revision: 2 } } }],
    ["contract revision", { contract: { ...contract, revision: 2 } }],
    ["governing specification", { sourceSpecifications: [{ ...specification, id: "plate-size-revised" }] }],
  ])("marks a report stale after a %s", (_label, override) => {
    const current = {
      plan,
      contract,
      sourceSpecifications: [specification],
      artifact: { id: "artifact-1", version: 1 },
      ...override,
    };
    expect(effectiveProofReport([report], current)?.status).toBe("stale");
  });

  it("keeps status-only plan revisions current", () => {
    const laterStatusPlan = { ...plan, domain: { ...plan.domain!, revision: 3 } };
    expect(effectiveProofReport([report], {
      plan: laterStatusPlan,
      contract,
      sourceSpecifications: [specification],
      artifact: { id: "artifact-1", version: 1 },
    })?.status).toBe("proven");
  });

  it.each([
    ["registration revision", {
      referenceRegistrations: [{ registrationId: "registration-1", referenceId: "reference-1", revision: 2, status: "current" }],
    }],
    ["active reference set", { activeReferenceIds: ["reference-1", "reference-2"] }],
    ["visual verification identity", { visualVerification: { id: "visual-2" } }],
  ])("invalidates reference-backed proof after a %s change", (_label, override) => {
    const registration = {
      registrationId: "registration-1",
      referenceId: "reference-1",
      revision: 1,
      status: "current",
    };
    const visual = { id: "visual-1", coveredReferenceIds: ["reference-1"] };
    const referenceReport = {
      ...report,
      referenceRegistrations: [registration],
      visualVerification: { state: "proven", record: visual },
    } as unknown as ProofReportDto;
    const current = {
      plan,
      contract,
      sourceSpecifications: [specification],
      artifact: { id: "artifact-1", version: 1 },
      referenceRegistrations: [registration],
      activeReferenceIds: ["reference-1"],
      visualVerification: visual,
      ...override,
    } as unknown as Parameters<typeof effectiveProofReport>[1];
    expect(effectiveProofReport([referenceReport], current)?.status).toBe("stale");
  });

  it("invalidates an unavailable visual result when new visual evidence appears", () => {
    const registration = {
      registrationId: "registration-1",
      referenceId: "reference-1",
      revision: 1,
      status: "current",
    };
    const unavailableReport = {
      ...report,
      status: "failed",
      referenceRegistrations: [registration],
      visualVerification: { state: "unavailable", reason: "not recorded", record: null },
    } as unknown as ProofReportDto;
    expect(effectiveProofReport([unavailableReport], {
      plan,
      contract,
      sourceSpecifications: [specification],
      artifact: { id: "artifact-1", version: 1 },
      referenceRegistrations: [registration],
      activeReferenceIds: ["reference-1"],
      visualVerification: { id: "visual-1", coveredReferenceIds: ["reference-1"] },
    } as unknown as Parameters<typeof effectiveProofReport>[1])?.status).toBe("stale");
  });
});
