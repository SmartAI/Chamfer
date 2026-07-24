import { describe, expect, it } from "vitest";
import type { CreateProofContractInput, ProofContractDto } from "@chamfer/shared";
import { REFERENCE_PROOF_POLICY, TEXT_PROOF_POLICY } from "@chamfer/shared";
import { createApp } from "../app";
import { createAttachment, createConversation, createMessage } from "../conversationStore";
import { openDb } from "../db";
import { appendEvidenceEvent } from "../evidenceStore";

async function postEvidence(app: ReturnType<typeof createApp>, conversationId: string, command: unknown) {
  return app.request(`/api/conversations/${conversationId}/evidence`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(command),
  });
}

async function seedAntecedents(app: ReturnType<typeof createApp>, conversationId: string) {
  const text = "Build a plate 30 mm wide.";
  await app.request(`/api/conversations/${conversationId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: `source-${conversationId}`,
      seq: 100,
      role: "user",
      contentJson: JSON.stringify({ role: "user", content: text, timestamp: 1 }),
    }),
  });
  await postEvidence(app, conversationId, {
    type: "record-source-specifications",
    idempotencyKey: `source-${conversationId}`,
    input: { specifications: [{
      id: "plate-size",
      requirement: "The plate must be 30 mm wide.",
      source: { messageId: `source-${conversationId}`, text: "30 mm wide", start: 14, end: 24 },
    }] },
  });
  await postEvidence(app, conversationId, {
    type: "record-plan",
    event: {
      id: `plan-${conversationId}`,
      type: "plan.recorded",
      data: { operation: "created", plan: { id: "plan-1", revision: 1 } },
    },
  });
}

function input(criteriaRevision: number, planRevision = criteriaRevision): CreateProofContractInput {
  return {
    derivation: {
      planId: "plan-1",
      planRevision,
      criteriaRevision,
      sourceSpecificationIds: ["plate-size"],
      component: { id: "plate", description: "mounting plate", bboxMm: [30, 20, 4] },
      criteria: [{
        id: "specification:plate-size",
        category: "explicit-requirement",
        statement: "The plate must be 30 x 20 x 4 mm.",
        sourceSpecificationId: "plate-size",
      }],
      plannedChecks: [{
        id: "envelope",
        componentId: "plate",
        kind: "bbox",
        criterion: { kind: "bbox", size_mm: [30, 20, 4], target: "plate" },
      }],
      unavailableEvidence: [],
      invalidatedEvidenceIds: criteriaRevision > 1 ? ["run-old"] : [],
      proofPolicy: TEXT_PROOF_POLICY,
      shapeProof: {
        status: "not-applicable",
        reason: "No eligible reference image was supplied for this text-only part.",
      },
    },
  };
}

describe("proof contract routes", () => {
  it("freezes exact retries idempotently and advances stable contract revisions", async () => {
    const app = createApp(openDb(":memory:"));
    const conversation = await app.request("/api/conversations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Proof contract", cadEnvironment: "build123d" }),
    });
    const { id } = await conversation.json() as { id: string };
    await seedAntecedents(app, id);
    const post = (body: CreateProofContractInput) => postEvidence(app, id, {
      type: "freeze-proof-contract", input: body, idempotencyKey: `contract-${body.derivation.criteriaRevision}`,
    });

    const first = ((await (await post(input(1))).json()) as { result: ProofContractDto }).result;
    const retry = ((await (await post(input(1))).json()) as { result: ProofContractDto }).result;
    expect(retry).toEqual(first);
    expect(first).toMatchObject({ revision: 1, status: "current", proofStatus: "pending" });

    await postEvidence(app, id, {
      type: "record-plan",
      event: { id: `plan-${id}-3`, type: "plan.recorded", data: { operation: "revised", plan: { id: "plan-1", revision: 3 } } },
    });
    const second = ((await (await post(input(2, 3))).json()) as { result: ProofContractDto }).result;
    expect(second.contractId).toBe(first.contractId);
    expect(second.revision).toBe(2);
    const list = (await (await app.request(`/api/conversations/${id}/evidence`)).json() as { proofContracts: ProofContractDto[] }).proofContracts;
    expect(list.map((contract) => ({ revision: contract.revision, status: contract.status, proofStatus: contract.proofStatus }))).toEqual([
      { revision: 1, status: "stale", proofStatus: "stale" },
      { revision: 2, status: "current", proofStatus: "pending" },
    ]);
    expect(list[1]!.derivation.invalidatedEvidenceIds).toEqual(["run-old"]);
  });

  it("rejects a changed retry and unsupported policy", async () => {
    const app = createApp(openDb(":memory:"));
    const conversation = await app.request("/api/conversations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Proof contract", cadEnvironment: "build123d" }),
    });
    const { id } = await conversation.json() as { id: string };
    await seedAntecedents(app, id);
    const post = (body: CreateProofContractInput) => postEvidence(app, id, {
      type: "freeze-proof-contract", input: body, idempotencyKey: `contract-${body.derivation.criteriaRevision}`,
    });
    expect((await post(input(1))).status).toBe(200);
    const changed = input(1);
    changed.derivation.component.description = "changed after freeze";
    expect((await post(changed)).status).toBe(409);
    const unsupported = input(2);
    unsupported.derivation.proofPolicy = { id: "agent-policy", version: 99 };
    expect((await post(unsupported)).status).toBe(400);
  });

  it("records and holds a weakening while accepting a tightening", async () => {
    const db = openDb(":memory:");
    const app = createApp(db);
    const conversation = await app.request("/api/conversations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Check ratchet", cadEnvironment: "build123d" }),
    });
    const { id } = await conversation.json() as { id: string };
    await seedAntecedents(app, id);
    const post = (body: CreateProofContractInput) => postEvidence(app, id, {
      type: "freeze-proof-contract", input: body, idempotencyKey: crypto.randomUUID(),
    });
    expect((await post(input(1))).status).toBe(200);

    await postEvidence(app, id, {
      type: "record-plan",
      event: { id: `plan-${id}-2`, type: "plan.recorded", data: { operation: "revised", plan: { id: "plan-1", revision: 2 } } },
    });
    const tightened = input(2);
    tightened.derivation.plannedChecks[0]!.criterion = { kind: "bbox", size_mm: [30, 20, 4], tol: 0.25, target: "plate" };
    const tightenedResponse = await post(tightened);
    expect(tightenedResponse.status).toBe(200);
    const tightenedContract = ((await tightenedResponse.json()) as { result: ProofContractDto }).result;
    expect(tightenedContract.checkRevision?.comparison.verdict).toBe("tighten");

    await postEvidence(app, id, {
      type: "record-plan",
      event: { id: `plan-${id}-3`, type: "plan.recorded", data: { operation: "revised", plan: { id: "plan-1", revision: 3 } } },
    });
    const loosened = input(3);
    loosened.derivation.plannedChecks[0]!.criterion = { kind: "bbox", size_mm: [30, 20, 4], tol: 1, target: "plate" };
    expect((await post(loosened)).status).toBe(409);

    const projection = await (await app.request(`/api/conversations/${id}/evidence`)).json() as {
      verificationCheckRevisionAttempts: Array<{
        attemptId: string;
        status: string;
        attemptedAt: number;
        comparison: { verdict: string };
      }>;
    };
    expect(projection.verificationCheckRevisionAttempts).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "accepted", comparison: expect.objectContaining({ verdict: "tighten" }) }),
      expect.objectContaining({ status: "held", comparison: expect.objectContaining({ verdict: "loosen" }) }),
    ]));

    const heldAt = projection.verificationCheckRevisionAttempts.find((attempt) => attempt.status === "held")!.attemptedAt;
    const escalation = {
      escalationId: "authorize-envelope-tolerance",
      conversationId: id,
      kind: "verification-check-relaxation" as const,
      question: "May the envelope tolerance increase to 1 mm?",
      affectedSpecificationIds: ["plate-size"],
      basis: "The exact held proposal requires a 1 mm tolerance.",
      verificationCheckAttemptId: projection.verificationCheckRevisionAttempts.find((attempt) =>
        attempt.status === "held")!.attemptId,
      status: "resolved" as const,
      openedAt: heldAt + 1,
      resolvedAt: heldAt + 2,
      resolutionSpecificationIds: ["plate-size"],
    };
    appendEvidenceEvent(db, id, {
      id: `opened-${escalation.escalationId}`,
      type: "design-escalation.opened",
      data: {
        escalation: {
          ...escalation,
          status: "pending",
          resolvedAt: undefined,
          resolutionSpecificationIds: [],
        },
      },
    });
    appendEvidenceEvent(db, id, {
      id: `resolved-${escalation.escalationId}`,
      type: "design-escalation.resolved",
      data: { escalation },
    });
    loosened.relaxationEscalationId = escalation.escalationId;
    expect((await post(loosened)).status).toBe(200);

    await postEvidence(app, id, {
      type: "record-plan",
      event: { id: `plan-${id}-4`, type: "plan.recorded", data: { operation: "revised", plan: { id: "plan-1", revision: 4 } } },
    });
    const unrelatedRelaxation = input(4);
    unrelatedRelaxation.derivation.plannedChecks[0]!.criterion = {
      kind: "bbox", size_mm: [30, 20, 4], tol: 2, target: "plate",
    };
    unrelatedRelaxation.relaxationEscalationId = escalation.escalationId;
    expect((await post(unrelatedRelaxation)).status).toBe(409);
  });

  it("stales a reference contract and accepts a same-criteria replacement when registration revision advances", async () => {
    const db = openDb(":memory:");
    const conversation = createConversation(db, "reference proof");
    createMessage(db, conversation.id, { id: "message-1", seq: 0, role: "user", contentJson: "{}" });
    createAttachment(db, "message-1", "user-image", {
      mime: "image/png",
      contentHash: "a".repeat(64),
      byteSize: 10,
      blobPath: "images/aa/reference.png",
    }, "reference-1");
    const payload = JSON.stringify({
      referenceId: "reference-1",
      sourceRegion: { x: 0, y: 0, width: 1, height: 1 },
      projection: "orthographic",
      direction: "front",
      visibleLandmarks: [],
      uncertainty: { level: "low", notes: "clear", occluded: false },
      geometry: {
        sourceSizePx: { width: 10, height: 10 },
        regionPx: { x: 0, y: 0, width: 10, height: 10 },
        extraction: { status: "failed", reason: "fixture", extractor: { id: "opencv-js-contour", version: 1 } },
      },
    });
    const app = createApp(db);
    await seedAntecedents(app, conversation.id);
    const registrationOne = {
      ...JSON.parse(payload),
      registrationId: "registration-1",
      conversationId: conversation.id,
      revision: 1,
      status: "current",
      eligibility: { status: "eligible", reasons: [] },
      timestamp: 1,
    } as const;
    appendEvidenceEvent(db, conversation.id, {
      id: "classification-1",
      type: "reference.classified",
      data: { attachmentAvailable: true, classification: {
        id: "classification-1", conversationId: conversation.id, referenceId: "reference-1",
        status: "active", purpose: "Front view", relationships: [], rationale: "Proof view",
        specificationIds: [], specificationLinks: [], actor: "agent", timestamp: 1,
      } },
    });
    appendEvidenceEvent(db, conversation.id, {
      id: "registration-1-event",
      type: "reference.registered",
      data: { registration: registrationOne },
    });
    const referenceInput = input(1);
    referenceInput.derivation.proofPolicy = REFERENCE_PROOF_POLICY;
    referenceInput.derivation.shapeProof = {
      status: "required",
      registrations: [{
        registrationId: "registration-1",
        referenceId: "reference-1",
        revision: 1,
        eligibility: "eligible",
      }],
      reason: "Current eligible source registration.",
    };
    const post = (body: CreateProofContractInput) => postEvidence(app, conversation.id, {
      type: "freeze-proof-contract", input: body, idempotencyKey: `reference-contract-${(body.derivation.shapeProof as { registrations?: Array<{ revision: number }> }).registrations?.[0]?.revision}`,
    });
    const first = ((await (await post(referenceInput)).json()) as { result: ProofContractDto }).result;
    expect(first).toMatchObject({ revision: 1, status: "current" });

    appendEvidenceEvent(db, conversation.id, {
      id: "registration-2-event",
      type: "reference.registered",
      data: { registration: { ...registrationOne, revision: 2, timestamp: 2 } },
    });
    const stale = (await (
      await app.request(`/api/conversations/${conversation.id}/evidence`)
    ).json() as { proofContracts: ProofContractDto[] }).proofContracts;
    expect(stale).toMatchObject([{ revision: 1, status: "stale", proofStatus: "stale" }]);

    const replacement = structuredClone(referenceInput);
    if (replacement.derivation.shapeProof.status !== "not-applicable") {
      replacement.derivation.shapeProof.registrations[0]!.revision = 2;
    }
    const second = ((await (await post(replacement)).json()) as { result: ProofContractDto }).result;
    expect(second).toMatchObject({ contractId: first.contractId, revision: 2, status: "current" });
  });
});
