import { describe, expect, it, vi } from "vitest";
import type {
  ConversationDto, FusionActionLedgerRecordDto, FusionDocumentIdentityDto, FusionEngineeringSnapshotDto, FusionReadinessDto,
} from "@chamfer/shared";
import { createApp } from "../app";
import { openDb } from "../db";

const endpoint = "http://127.0.0.1:27182/mcp";
const provisional = { id: "creation-1", name: "Unsaved Bracket" };
const durable = { id: "creation-1", name: "Bracket", dataFileId: "data-1", versionId: "version-7", versionNumber: 7 };
const snapshot: FusionEngineeringSnapshotDto = {
  designIntent: { designType: "parametric", rootComponent: "Bracket", timelineMarker: 1 },
  units: { distance: "mm", angle: "deg", internalDistance: "cm" }, parameters: [], sketches: [], features: [],
  bodies: [{ id: "body-1", name: "Body", solid: true, volumeMm3: 1, boundingBoxMm: [1, 1, 1], geometrySignature: {
    faceCount: 6, edgeCount: 12, faceAreasMm2: [], edgeLengthsMm: [], boundingBoxMinMm: [0, 0, 0],
    boundingBoxMaxMm: [1, 1, 1], centerOfMassMm: [0.5, 0.5, 0.5], bodyRevisionId: "body-rev",
  } }], materials: [], entities: [],
};

function readiness(document: FusionDocumentIdentityDto = provisional, documentModified = !document.dataFileId): FusionReadinessDto {
  return { state: "ready", label: "Ready", diagnosis: "Fusion is ready.", endpoint,
    checkedAt: "2026-07-14T12:00:00.000Z", document, documentModified, mutationAllowed: true };
}

async function createFusionConversation(app: ReturnType<typeof createApp>): Promise<ConversationDto> {
  const response = await app.request("/api/conversations", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Save", cadEnvironment: "fusion" }) });
  return response.json() as Promise<ConversationDto>;
}

function seedVerifiedCompletion(db: ReturnType<typeof openDb>, conversationId: string, document = provisional, verified = true): void {
  db.prepare(`INSERT INTO fusion_inspections
    (id, conversation_id, revision, snapshot_json, checks_json, screenshots_json, camera_restored, captured_at, stale_at)
    VALUES ('inspection-1', ?, 'rev-1', ?, ?, '[]', 1, 1, NULL)`)
    .run(conversationId, JSON.stringify(snapshot), JSON.stringify([{ kind: "body-count", status: "passed", detail: "one body" }]));
  const record: FusionActionLedgerRecordDto = {
    id: "ledger-1", conversationId, actionId: "action-1", event: "completed", recordedAt: 2, document,
    expectedRevision: "rev-0", observedRevision: "rev-1", finalRevision: "rev-1",
    model: { provider: "openai", model: "gpt-5" }, skills: { foundation: { name: "fusion-foundation", version: "1" }, loaded: [] },
    policyVersion: "fusion-python-v1", intent: "Create bracket", bodySha256: "hash", affectedReferences: [], expectedEffects: [],
    result: verified
      ? { status: "completed", checks: [{ kind: "body-count", status: "passed" }] }
      : { status: "nonconforming", checks: [{ kind: "body-count", status: "failed" }] },
    evidenceIds: ["inspection-1"],
  };
  db.prepare(`INSERT INTO fusion_action_ledger
    (id, conversation_id, action_id, event, recorded_at, document_json, expected_revision, observed_revision, final_revision,
     model_json, skills_json, policy_version, intent, body_sha256, affected_references_json, expected_effects_json, result_json, evidence_ids_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(record.id, conversationId, record.actionId, record.event, record.recordedAt, JSON.stringify(record.document), record.expectedRevision,
      record.observedRevision ?? null, record.finalRevision ?? null, JSON.stringify(record.model), JSON.stringify(record.skills), record.policyVersion,
      record.intent, record.bodySha256, "[]", "[]", JSON.stringify(record.result), JSON.stringify(record.evidenceIds));
}

async function prepared(overrides: {
  save?: ReturnType<typeof vi.fn>;
  current?: ReturnType<typeof vi.fn>;
  verified?: boolean;
  initialDocument?: FusionDocumentIdentityDto;
  savedDocument?: FusionDocumentIdentityDto;
  documentModified?: boolean;
} = {}) {
  const db = openDb(":memory:");
  const initialDocument: FusionDocumentIdentityDto = overrides.initialDocument ?? provisional;
  const savedDocument: FusionDocumentIdentityDto = overrides.savedDocument ?? durable;
  const current = overrides.current ?? vi.fn().mockResolvedValue(
    readiness(initialDocument, overrides.documentModified ?? !initialDocument.dataFileId),
  );
  const save = overrides.save ?? vi.fn().mockResolvedValue({ document: savedDocument, captured: {
    snapshot, revision: "rev-1", screenshots: [], cameraRestored: true,
  }, readiness: readiness(savedDocument, false) });
  const app = createApp(db, undefined, { fusionReadiness: { current }, fusionLifecycleRuntime: { save } });
  const conversation = await createFusionConversation(app);
  await app.request(`/api/conversations/${conversation.id}/fusion-binding`, { method: "POST" });
  seedVerifiedCompletion(db, conversation.id, initialDocument, overrides.verified ?? true);
  return { app, db, conversation, current, save };
}

describe("Fusion lifecycle Save route", () => {
  it("explicitly saves verified unsaved work, promotes the existing binding, records version metadata, and survives reload", async () => {
    const { app, db, conversation, save } = await prepared();
    const response = await app.request(`/api/conversations/${conversation.id}/fusion-save`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ document: provisional }) });

    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({ binding: { conversationId: conversation.id, identityKind: "durable",
      document: durable }, inspection: { current: { revision: "rev-1" } }, evidence: { resultingDocument: durable, revision: "rev-1" } });
    expect(result.evidence.inspection.id).not.toBe("inspection-1");
    expect(save).toHaveBeenCalledWith(provisional, "rev-1");
    expect(db.prepare("SELECT COUNT(*) AS count FROM fusion_document_bindings WHERE conversation_id = ?").get(conversation.id))
      .toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM fusion_save_evidence WHERE conversation_id = ?").get(conversation.id))
      .toEqual({ count: 1 });
    expect(await (await app.request(`/api/fusion/readiness?conversationId=${conversation.id}`)).json())
      .toMatchObject({ binding: { identityKind: "durable", document: durable } });
  });

  it("saves verified modifications to an already durable binding and rejects a clean durable document", async () => {
    const nextVersion = { ...durable, versionId: "version-8", versionNumber: 8 };
    const modified = await prepared({ initialDocument: durable, savedDocument: nextVersion, documentModified: true });
    const saved = await modified.app.request(`/api/conversations/${modified.conversation.id}/fusion-save`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ document: durable }) });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ binding: { document: nextVersion } });

    const clean = await prepared({ initialDocument: durable, documentModified: false });
    const refused = await clean.app.request(`/api/conversations/${clean.conversation.id}/fusion-save`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ document: durable }) });
    expect(refused.status).toBe(409);
    expect(clean.save).not.toHaveBeenCalled();
  });

  it("refuses inferred, unverified, read-only, and mismatched lifecycle actions", async () => {
    const unverified = await prepared({ verified: false });
    expect((await unverified.app.request(`/api/conversations/${unverified.conversation.id}/fusion-save`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ document: provisional }) })).status).toBe(409);
    expect(unverified.save).not.toHaveBeenCalled();

    const readOnly = await prepared();
    readOnly.db.prepare("UPDATE fusion_document_bindings SET role = 'read-only'").run();
    expect((await readOnly.app.request(`/api/conversations/${readOnly.conversation.id}/fusion-save`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ document: provisional }) })).status).toBe(409);

    const mismatched = await prepared();
    const mismatch = await mismatched.app.request(`/api/conversations/${mismatched.conversation.id}/fusion-save`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ document: { id: "other", name: "Other" } }) });
    expect(mismatch.status).toBe(409);
    expect(mismatched.save).not.toHaveBeenCalled();
  });

  it.each(["canceled", "failed"])("retains verified unsaved state when Save is %s", async (outcome) => {
    const save = vi.fn().mockRejectedValue(new Error(outcome === "canceled" ? "Fusion Save was canceled." : "Fusion Save failed."));
    const { app, conversation } = await prepared({ save });
    const response = await app.request(`/api/conversations/${conversation.id}/fusion-save`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ document: provisional }) });
    expect(response.status).toBe(outcome === "canceled" ? 409 : 503);
    expect(await (await app.request(`/api/fusion/readiness?conversationId=${conversation.id}`)).json())
      .toMatchObject({ binding: { identityKind: "provisional", document: provisional } });
  });

  it("preserves the provisional binding when post-save identity does not match", async () => {
    const save = vi.fn().mockResolvedValue({ document: { ...durable, id: "other" }, captured: {
      snapshot, revision: "rev-1", screenshots: [], cameraRestored: true,
    }, readiness: readiness({ ...durable, id: "other" }, false) });
    const { app, conversation } = await prepared({ save });
    const response = await app.request(`/api/conversations/${conversation.id}/fusion-save`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ document: provisional }) });
    expect(response.status).toBe(409);
    expect(await (await app.request(`/api/fusion/readiness?conversationId=${conversation.id}`)).json())
      .toMatchObject({ binding: { identityKind: "provisional", document: provisional } });
  });

  it("preserves the provisional binding when the active document changes during final post-save readiness", async () => {
    const save = vi.fn().mockResolvedValue({ document: durable, captured: {
      snapshot, revision: "rev-1", screenshots: [], cameraRestored: true,
    }, readiness: readiness({ id: "other", name: "Other", dataFileId: "other-data" }, false) });
    const { app, db, conversation } = await prepared({ save });
    const response = await app.request(`/api/conversations/${conversation.id}/fusion-save`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ document: provisional }) });
    expect(response.status).toBe(409);
    expect(db.prepare("SELECT COUNT(*) AS count FROM fusion_save_evidence WHERE conversation_id = ?").get(conversation.id))
      .toEqual({ count: 0 });
    expect(await (await app.request(`/api/fusion/readiness?conversationId=${conversation.id}`)).json())
      .toMatchObject({ binding: { identityKind: "provisional", document: provisional } });
  });

  it("preserves degraded readiness from the independent post-save inspection", async () => {
    const degraded = { ...readiness(durable, false), state: "degraded" as const, label: "Degraded",
      diagnosis: "Fusion did not restore the camera.", mutationAllowed: false };
    const save = vi.fn().mockResolvedValue({ document: durable, captured: {
      snapshot, revision: "rev-1", screenshots: [], cameraRestored: false,
    }, readiness: degraded });
    const { app, conversation } = await prepared({ save });
    const response = await app.request(`/api/conversations/${conversation.id}/fusion-save`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ document: provisional }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ inspection: { readiness: {
      state: "degraded", mutationAllowed: false,
    }, current: { cameraRestored: false } } });
  });
});
