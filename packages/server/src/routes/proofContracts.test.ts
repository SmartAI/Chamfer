import { describe, expect, it } from "vitest";
import type { CreateProofContractInput, ProofContractDto } from "@chamfer/shared";
import { REFERENCE_PROOF_POLICY, TEXT_PROOF_POLICY } from "@chamfer/shared";
import { createApp } from "../app";
import { createAttachment, createConversation, createMessage } from "../conversationStore";
import { openDb } from "../db";

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
    const post = (body: CreateProofContractInput) => app.request(`/api/conversations/${id}/proof-contracts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    const first = await (await post(input(1))).json() as ProofContractDto;
    const retry = await (await post(input(1))).json() as ProofContractDto;
    expect(retry).toEqual(first);
    expect(first).toMatchObject({ revision: 1, status: "current", proofStatus: "pending" });

    const second = await (await post(input(2, 3))).json() as ProofContractDto;
    expect(second.contractId).toBe(first.contractId);
    expect(second.revision).toBe(2);
    const list = await (await app.request(`/api/conversations/${id}/proof-contracts`)).json() as ProofContractDto[];
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
    const post = (body: CreateProofContractInput) => app.request(`/api/conversations/${id}/proof-contracts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect((await post(input(1))).status).toBe(200);
    const changed = input(1);
    changed.derivation.component.description = "changed after freeze";
    expect((await post(changed)).status).toBe(409);
    const unsupported = input(2);
    unsupported.derivation.proofPolicy = { id: "agent-policy", version: 99 };
    expect((await post(unsupported)).status).toBe(400);
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
    const insertRegistration = (eventId: string, revision: number) => db.prepare(`INSERT INTO reference_registrations
      (event_id, registration_id, conversation_id, reference_id, revision, payload_json,
       eligibility_json, created_at)
      VALUES (?, 'registration-1', ?, 'reference-1', ?, ?, ?, ?)`)
      .run(eventId, conversation.id, revision, payload, JSON.stringify({ status: "eligible", reasons: [] }), revision);
    insertRegistration("registration-event-1", 1);

    const app = createApp(db);
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
    const post = (body: CreateProofContractInput) => app.request(`/api/conversations/${conversation.id}/proof-contracts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const first = await (await post(referenceInput)).json() as ProofContractDto;
    expect(first).toMatchObject({ revision: 1, status: "current" });

    insertRegistration("registration-event-2", 2);
    const stale = await (
      await app.request(`/api/conversations/${conversation.id}/proof-contracts`)
    ).json() as ProofContractDto[];
    expect(stale).toMatchObject([{ revision: 1, status: "stale", proofStatus: "stale" }]);

    const replacement = structuredClone(referenceInput);
    if (replacement.derivation.shapeProof.status !== "not-applicable") {
      replacement.derivation.shapeProof.registrations[0]!.revision = 2;
    }
    const second = await (await post(replacement)).json() as ProofContractDto;
    expect(second).toMatchObject({ contractId: first.contractId, revision: 2, status: "current" });
  });
});
