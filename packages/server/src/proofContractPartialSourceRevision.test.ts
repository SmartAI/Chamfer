import { describe, expect, it } from "vitest";
import type { CreateProofContractInput, ProofContractPlannedCheckDto } from "@chamfer/shared";
import { TEXT_PROOF_POLICY } from "@chamfer/shared";
import { createConversation, createMessage } from "./conversationStore";
import { openDb } from "./db";
import { appendEvidenceEvent } from "./evidenceStore";
import { freezeProofContract } from "./routes/proofContracts";

function input(
  revision: number,
  sourceSpecificationIds: string[],
  checks: ProofContractPlannedCheckDto[],
): CreateProofContractInput {
  return {
    derivation: {
      planId: "plan-1",
      planRevision: revision,
      criteriaRevision: revision,
      sourceSpecificationIds,
      component: { id: "spacer", description: "rectangular spacer", bboxMm: [10, 10, 10] },
      criteria: sourceSpecificationIds.map((id) => ({
        id: `specification:${id}`,
        category: "explicit-requirement",
        statement: id,
        sourceSpecificationId: id,
      })),
      plannedChecks: checks,
      unavailableEvidence: [],
      invalidatedEvidenceIds: revision > 1 ? ["run-v1"] : [],
      proofPolicy: TEXT_PROOF_POLICY,
      shapeProof: {
        status: "not-applicable",
        reason: "No reference image was supplied.",
      },
    },
  };
}

const initialChecks: ProofContractPlannedCheckDto[] = [{
  id: "envelope",
  componentId: "spacer",
  kind: "bbox",
  criterion: { kind: "bbox", size_mm: [10, 10, 10], target: "spacer" },
}, {
  id: "wall",
  componentId: "spacer",
  kind: "wall_thickness",
  criterion: { kind: "wall_thickness", range_mm: [4, 5], target: "spacer" },
}];

describe("partial source revision authorization", () => {
  it("does not let one corrected source authorize weakening criteria retained from another source", () => {
    const db = openDb(":memory:");
    const conversation = createConversation(db, "Partial corrected source");
    createMessage(db, conversation.id, {
      id: "message-1",
      seq: 0,
      role: "user",
      contentJson: JSON.stringify({ role: "user", content: "width height correction", timestamp: 1 }),
    });
    appendEvidenceEvent(db, conversation.id, {
      id: "source-v1",
      type: "source-specifications.recorded",
      data: {
        specifications: [{
          id: "width-v1",
          requirement: "The width is 10 mm.",
          source: { messageId: "message-1", text: "width", start: 0, end: 5 },
          conversationId: conversation.id,
          actor: "agent",
          status: "active",
          timestamp: 1,
        }, {
          id: "wall-v1",
          requirement: "The wall is at least 4 mm.",
          source: { messageId: "message-1", text: "height", start: 6, end: 12 },
          conversationId: conversation.id,
          actor: "agent",
          status: "active",
          timestamp: 1,
        }],
      },
    });
    appendEvidenceEvent(db, conversation.id, {
      id: "plan-v1",
      type: "plan.recorded",
      data: { operation: "created", plan: { id: "plan-1", revision: 1 } },
    });
    freezeProofContract(
      db,
      conversation.id,
      input(1, ["width-v1", "wall-v1"], initialChecks),
    );

    appendEvidenceEvent(db, conversation.id, {
      id: "source-v2",
      type: "source-specifications.recorded",
      data: {
        specifications: [{
          id: "width-v2",
          requirement: "The corrected width is 12 mm.",
          source: { messageId: "message-1", text: "correction", start: 13, end: 23 },
          supersedesSpecificationId: "width-v1",
          conversationId: conversation.id,
          actor: "agent",
          status: "active",
          timestamp: 2,
        }],
      },
    });
    appendEvidenceEvent(db, conversation.id, {
      id: "plan-v2",
      type: "plan.recorded",
      data: { operation: "revised", plan: { id: "plan-1", revision: 2 } },
    });

    expect(() => freezeProofContract(
      db,
      conversation.id,
      input(2, ["wall-v1", "width-v2"], [{
        ...initialChecks[0]!,
        criterion: { kind: "bbox", size_mm: [12, 10, 10], target: "spacer" },
      }, {
        ...initialChecks[1]!,
        criterion: { kind: "wall_thickness", range_mm: [3, 5], target: "spacer" },
      }]),
    )).toThrow(/checks would loosen/);
  });
});
