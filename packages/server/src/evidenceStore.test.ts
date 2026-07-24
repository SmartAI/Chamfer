import { describe, expect, it } from "vitest";
import { createConversation } from "./conversationStore";
import { openDb } from "./db";
import {
  appendEvidenceEvent,
  EvidenceIntegrityError,
  listEvidenceEvents,
  projectEvidence,
} from "./evidenceStore";

describe("evidence store", () => {
  it("advances a large warm ledger in place and bounds cached conversations", () => {
    const db = openDb(":memory:");
    const conversation = createConversation(db, "Large ledger");
    for (let index = 0; index < 1_000; index += 1) {
      appendEvidenceEvent(db, conversation.id, {
        id: `verification-${index}`,
        type: "environment-verification.recorded",
        data: {
          environment: "build123d",
          scope: "design",
          candidateId: `candidate-${index}`,
          status: "failed",
          measurements: { bodyCount: 0, volumeMm3: 0 },
          views: [],
          checks: [],
        },
      });
    }
    const warm = projectEvidence(db, conversation.id);
    appendEvidenceEvent(db, conversation.id, {
      id: "verification-latest",
      type: "environment-verification.recorded",
      data: {
        environment: "build123d",
        scope: "design",
        candidateId: "candidate-latest",
        status: "failed",
        measurements: { bodyCount: 0, volumeMm3: 0 },
        views: [],
        checks: [],
      },
    });

    expect(projectEvidence(db, conversation.id)).toBe(warm);
    expect(warm.events).toHaveLength(1_001);

    const firstProjection = projectEvidence(db, conversation.id);
    for (let index = 0; index < 32; index += 1) {
      const other = createConversation(db, `Ledger ${index}`);
      appendEvidenceEvent(db, other.id, {
        id: `other-verification-${index}`,
        type: "environment-verification.recorded",
        data: {
          environment: "build123d",
          scope: "design",
          candidateId: `other-candidate-${index}`,
          status: "failed",
          measurements: { bodyCount: 0, volumeMm3: 0 },
          views: [],
          checks: [],
        },
      });
      projectEvidence(db, other.id);
    }
    expect(projectEvidence(db, conversation.id)).not.toBe(firstProjection);
  });

  it("appends in conversation order and replays the durable projection", () => {
    const db = openDb(":memory:");
    const conversation = createConversation(db, "Ledger");

    const recorded = appendEvidenceEvent(db, conversation.id, {
      id: "plan-event",
      type: "plan.recorded",
      data: { operation: "created", plan: { id: "plan-1", revision: 1 } },
    });

    expect(recorded).toMatchObject({
      id: "plan-event",
      conversationId: conversation.id,
      sequence: 1,
      type: "plan.recorded",
    });
    expect(listEvidenceEvents(db, conversation.id)).toEqual([recorded]);
    expect(projectEvidence(db, conversation.id).activePlan).toEqual({ id: "plan-1", revision: 1 });
  });

  it("treats an identical evidence-event retry as an idempotent append", () => {
    const db = openDb(":memory:");
    const conversation = createConversation(db, "Ledger");
    const draft = {
      id: "verification-attempt-1",
      type: "environment-verification.recorded" as const,
      data: {
        environment: "build123d" as const,
        scope: "design" as const,
        candidateId: "candidate-1",
        status: "failed" as const,
        measurements: { bodyCount: 0, volumeMm3: 0 },
        views: [],
        checks: [],
      },
    };

    const recorded = appendEvidenceEvent(db, conversation.id, draft);
    const retried = appendEvidenceEvent(db, conversation.id, draft);

    expect(retried).toEqual(recorded);
    expect(listEvidenceEvents(db, conversation.id)).toEqual([recorded]);
  });

  it("rejects missing antecedents with an actionable error and records nothing", () => {
    const db = openDb(":memory:");
    const conversation = createConversation(db, "Ledger");

    expect(() => appendEvidenceEvent(db, conversation.id, {
      id: "contract-event",
      type: "proof-contract.frozen",
      data: {
        contract: {
          contractId: "contract-1",
          conversationId: conversation.id,
          revision: 1,
          status: "current",
          proofStatus: "pending",
          frozenAt: 1,
          derivation: {
            planId: "missing-plan",
            planRevision: 1,
            criteriaRevision: 1,
            sourceSpecificationIds: ["missing-specification"],
            component: { id: "body", description: "Body" },
            criteria: [],
            plannedChecks: [],
            unavailableEvidence: [],
            invalidatedEvidenceIds: [],
            proofPolicy: { id: "proven-single-part-text", version: 1 },
            shapeProof: { status: "not-applicable", reason: "Text-only." },
          },
        },
      },
    })).toThrowError(new EvidenceIntegrityError(
      "proof contract contract-1 references missing plan missing-plan revision 1",
    ));
    expect(listEvidenceEvents(db, conversation.id)).toEqual([]);
  });

  it("makes recorded evidence immutable at the database boundary", () => {
    const db = openDb(":memory:");
    const conversation = createConversation(db, "Ledger");
    appendEvidenceEvent(db, conversation.id, {
      id: "plan-event",
      type: "plan.recorded",
      data: { operation: "created", plan: { id: "plan-1", revision: 1 } },
    });

    expect(() => db.prepare("UPDATE evidence_events SET data_json = '{}' WHERE id = ?").run("plan-event"))
      .toThrow(/evidence ledger is immutable/i);
    expect(() => db.prepare("DELETE FROM evidence_events WHERE id = ?").run("plan-event"))
      .toThrow(/evidence ledger is immutable/i);
  });

  it("rejects a classification for a missing reference image", () => {
    const db = openDb(":memory:");
    const conversation = createConversation(db, "Ledger");

    expect(() => appendEvidenceEvent(db, conversation.id, {
      id: "classification-event",
      type: "reference.classified",
      data: {
        attachmentAvailable: true,
        classification: {
          id: "classification-1",
          conversationId: conversation.id,
          referenceId: "missing-reference",
          status: "active",
          purpose: "Front view",
          relationships: [],
          rationale: "Defines the requested form.",
          specificationIds: [],
          specificationLinks: [],
          actor: "agent",
          timestamp: 1,
        },
      },
    })).toThrowError(/classification classification-1 references missing image missing-reference/);
  });

  it("rejects a second event that rewrites an existing plan revision", () => {
    const db = openDb(":memory:");
    const conversation = createConversation(db, "Ledger");
    appendEvidenceEvent(db, conversation.id, {
      id: "plan-event-1",
      type: "plan.recorded",
      data: { operation: "created", plan: { id: "plan-1", revision: 1, goal: "Original" } },
    });

    expect(() => appendEvidenceEvent(db, conversation.id, {
      id: "plan-event-2",
      type: "plan.recorded",
      data: { operation: "revised", plan: { id: "plan-1", revision: 1, goal: "Rewritten" } },
    })).toThrowError(/plan plan-1 revision 1 is already recorded/);
    expect(projectEvidence(db, conversation.id).activePlan).toMatchObject({ goal: "Original" });
  });

  it("rejects proof-report invalidation for an artifact version that does not exist", () => {
    const db = openDb(":memory:");
    const conversation = createConversation(db, "Ledger");

    expect(() => appendEvidenceEvent(db, conversation.id, {
      id: "missing-artifact-invalidation",
      type: "proof-reports.invalidated",
      data: { latestArtifactVersion: 42 },
    })).toThrowError(/artifact version 42 is not stored for this conversation/);
    expect(listEvidenceEvents(db, conversation.id)).toEqual([]);
  });

  it("requires passed environment verification to be bound to this conversation's immutable candidate", () => {
    const db = openDb(":memory:");
    const conversation = createConversation(db, "Ledger");
    const other = createConversation(db, "Other");
    db.prepare("INSERT INTO artifacts (id, conversation_id, version, py_source, created_at) VALUES (?, ?, 1, 'result = Box(1, 1, 1)', 1)")
      .run("other-artifact", other.id);
    const event = {
      id: "environment-verification",
      type: "environment-verification.recorded" as const,
      data: {
        environment: "build123d" as const,
        scope: "design" as const,
        candidateId: "build-run-1",
        status: "passed" as const,
        measurements: { bodyCount: 1, volumeMm3: 1 },
        views: ["isometric"],
        checks: [],
      },
    };

    expect(() => appendEvidenceEvent(db, conversation.id, event))
      .toThrowError(/requires an immutable artifact identity/);
    expect(() => appendEvidenceEvent(db, conversation.id, {
      ...event,
      id: "cross-conversation-verification",
      data: { ...event.data, artifact: { id: "other-artifact", version: 1 } },
    })).toThrowError(/references missing artifact other-artifact version 1/);
    expect(listEvidenceEvents(db, conversation.id)).toEqual([]);
  });

  it("rejects malformed measured comparison payloads at the typed event boundary", () => {
    const db = openDb(":memory:");
    const conversation = createConversation(db, "Ledger");

    expect(() => appendEvidenceEvent(db, conversation.id, {
      id: "malformed-comparison",
      type: "visual-comparison.recorded",
      data: { comparison: { evidenceId: "comparison-only" } },
    } as never)).toThrowError(/does not match its typed payload schema/);
    expect(listEvidenceEvents(db, conversation.id)).toEqual([]);
  });
});
