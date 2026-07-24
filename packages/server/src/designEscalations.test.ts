import { describe, expect, it } from "vitest";
import { createConversation, createMessage } from "./conversationStore";
import { openDb } from "./db";
import { listDesignEscalations, openDesignEscalation } from "./designEscalations";
import { appendEvidenceEvent } from "./evidenceStore";
import { listSourceSpecifications, recordSourceSpecifications } from "./sourceSpecifications";
import { listDurableNotes } from "./durableNotes";

describe("durable design escalations", () => {
  it("accepts a dedicated user-visible verification check relaxation", () => {
    const db = openDb(":memory:");
    const conversation = createConversation(db, "Check correction");
    appendEvidenceEvent(db, conversation.id, {
      id: "held-relax-volume-range",
      type: "verification-checks.revision-attempted",
      data: {
        attempt: {
          attemptId: "attempt-relax-volume-range",
          planId: "plan-1",
          proposedCriteriaRevision: 2,
          proposedChecks: [],
          comparison: { verdict: "loosen", checks: [] },
          status: "held",
          attemptedAt: 1,
        },
      },
    });
    const escalation = openDesignEscalation(db, conversation.id, {
      escalationId: "relax-volume-range",
      kind: "verification-check-relaxation",
      question: "May I widen the frozen volume range from 10-20 to 8-22 cubic millimetres?",
      affectedSpecificationIds: [],
      basis: "The accepted check used the wrong derived manufacturing allowance.",
      verificationCheckAttemptId: "attempt-relax-volume-range",
    }, "relax-volume-range");

    expect(escalation).toMatchObject({
      kind: "verification-check-relaxation",
      status: "pending",
      verificationCheckAttemptId: "attempt-relax-volume-range",
    });
  });

  it("persists one focused question and resolves it only with later user source evidence", () => {
    const db = openDb(":memory:");
    const conversation = createConversation(db, "Conflict");
    const initial = "One note says 10 mm and another says 12 mm.";
    createMessage(db, conversation.id, {
      id: "initial",
      seq: 0,
      role: "user",
      contentJson: JSON.stringify({ role: "user", content: initial, timestamp: 1 }),
    });
    const quote = (text: string) => ({
      messageId: "initial",
      text,
      start: initial.indexOf(text),
      end: initial.indexOf(text) + text.length,
    });
    recordSourceSpecifications(db, conversation.id, {
      specifications: [
        {
          id: "width-10",
          requirement: "Width is 10 mm.",
          source: quote("10 mm"),
          conflictsWithSpecificationIds: ["width-12"],
        },
        {
          id: "width-12",
          requirement: "Width is 12 mm.",
          source: quote("12 mm"),
          conflictsWithSpecificationIds: ["width-10"],
        },
      ],
    }, "sources");

    const input = {
      escalationId: "width-conflict",
      kind: "conflicting-specifications" as const,
      question: "Should the spacer be 10 mm or 12 mm wide?",
      affectedSpecificationIds: ["width-10", "width-12"],
      basis: "The active source evidence conflicts.",
    };
    const opened = openDesignEscalation(db, conversation.id, input, "open-conflict");
    expect(opened).toMatchObject({ status: "pending", resolutionSpecificationIds: [] });
    expect(openDesignEscalation(db, conversation.id, input, "open-conflict")).toEqual(opened);
    expect(() => openDesignEscalation(db, conversation.id, { ...input, escalationId: "second" }, "second"))
      .toThrowError(/already pending/);

    const answer = "Use 12 mm wide.";
    createMessage(db, conversation.id, {
      id: "answer",
      seq: 1,
      role: "user",
      contentJson: JSON.stringify({ role: "user", content: answer, timestamp: 2 }),
    });
    recordSourceSpecifications(db, conversation.id, {
      resolvesEscalationId: "width-conflict",
      specifications: [{
        id: "width-resolved",
        requirement: "Width is 12 mm.",
        source: { messageId: "answer", text: answer, start: 0, end: answer.length },
        supersedesSpecificationIds: ["width-10", "width-12"],
      }],
    }, "answer-source");

    expect(listDesignEscalations(db, conversation.id)).toMatchObject([{
      escalationId: "width-conflict",
      status: "resolved",
      resolutionSpecificationIds: ["width-resolved"],
    }]);
    expect(listSourceSpecifications(db, conversation.id)).toMatchObject([
      { id: "width-10", status: "superseded", supersededBySpecificationId: "width-resolved" },
      { id: "width-12", status: "superseded", supersededBySpecificationId: "width-resolved" },
      { id: "width-resolved", status: "active", supersedesSpecificationIds: ["width-10", "width-12"] },
    ]);
    expect(listDurableNotes(db, conversation.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "question:width-conflict", kind: "open-question", status: "resolved" }),
      expect.objectContaining({ id: "decision:width-resolved", kind: "user-decision", status: "active" }),
    ]));
  });
});
