import { describe, expect, it } from "vitest";
import type { CreateProofContractInput } from "@chamfer/shared";
import { TEXT_PROOF_POLICY } from "@chamfer/shared";
import { createConversation, createMessage } from "./conversationStore";
import { openDb } from "./db";
import { appendEvidenceEvent } from "./evidenceStore";
import { freezeProofContract } from "./routes/proofContracts";

function contractInput(
  criteriaRevision: number,
  sourceSpecificationId: string,
  width: number,
  volume: [number, number],
): CreateProofContractInput {
  return {
    derivation: {
      planId: "plan-1",
      planRevision: criteriaRevision,
      criteriaRevision,
      sourceSpecificationIds: [sourceSpecificationId],
      component: { id: "spacer", description: "rectangular spacer", bboxMm: [width, 10, 10] },
      criteria: [{
        id: `specification:${sourceSpecificationId}`,
        category: "explicit-requirement",
        statement: `The spacer width is ${width} mm.`,
        sourceSpecificationId,
      }],
      plannedChecks: [
        {
          id: "envelope",
          componentId: "spacer",
          kind: "bbox",
          criterion: { kind: "bbox", size_mm: [width, 10, 10], target: "spacer" },
        },
        {
          id: "volume",
          componentId: "spacer",
          kind: "volume",
          criterion: { kind: "volume", range_mm3: volume, target: "spacer" },
        },
      ],
      unavailableEvidence: [],
      invalidatedEvidenceIds: criteriaRevision > 1 ? ["run-v1"] : [],
      proofPolicy: TEXT_PROOF_POLICY,
      shapeProof: {
        status: "not-applicable",
        reason: "No eligible reference image was supplied for this text-only part.",
      },
    },
  };
}

describe("proof contract source revision", () => {
  it("accepts corrected checks when the active source explicitly supersedes the frozen source", () => {
    const db = openDb(":memory:");
    const conversation = createConversation(db, "Corrected source");
    createMessage(db, conversation.id, {
      id: "message-1",
      seq: 0,
      role: "user",
      contentJson: JSON.stringify({ role: "user", content: "10 mm 12 mm", timestamp: 1 }),
    });
    appendEvidenceEvent(db, conversation.id, {
      id: "source-v1",
      type: "source-specifications.recorded",
      data: {
        specifications: [{
          id: "width-v1",
          requirement: "The spacer width is 10 mm.",
          source: { messageId: "message-1", text: "10 mm", start: 0, end: 5 },
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
    const first = freezeProofContract(db, conversation.id, contractInput(1, "width-v1", 10, [900, 1100]));

    appendEvidenceEvent(db, conversation.id, {
      id: "source-v2",
      type: "source-specifications.recorded",
      data: {
        specifications: [{
          id: "width-v2",
          requirement: "The corrected spacer width is 12 mm.",
          source: { messageId: "message-1", text: "12 mm", start: 6, end: 11 },
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

    const corrected = freezeProofContract(
      db,
      conversation.id,
      contractInput(2, "width-v2", 12, [1080, 1320]),
    );

    expect(corrected).toMatchObject({
      contractId: first.contractId,
      revision: 2,
      status: "current",
      checkRevision: {
        authorizedBySourceSpecificationIds: ["width-v2"],
      },
    });
  });
});
