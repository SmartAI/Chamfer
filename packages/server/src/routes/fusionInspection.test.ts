import { describe, expect, it, vi } from "vitest";
import type {
  ConversationDto,
  FusionEngineeringSnapshotDto,
  FusionReadinessDto,
} from "@chamfer/shared";
import { createApp } from "../app";
import { openDb } from "../db";

const endpoint = "http://127.0.0.1:27182/mcp";
const document = { id: "creation-1", name: "Bracket", dataFileId: "data-1" };
const baseSnapshot: FusionEngineeringSnapshotDto = {
  designIntent: { designType: "parametric", rootComponent: "Bracket", timelineMarker: 1 },
  units: { distance: "mm", angle: "deg", internalDistance: "cm" },
  parameters: [{ id: "width", name: "width", expression: "80 mm", valueMm: 80, unit: "mm" }],
  sketches: [],
  features: [],
  bodies: [{
    id: "body-1", name: "Body", solid: true, volumeMm3: 100, boundingBoxMm: [10, 10, 1],
    geometrySignature: {
      faceCount: 6, edgeCount: 12, faceAreasMm2: [], edgeLengthsMm: [],
      boundingBoxMinMm: [0, 0, 0], boundingBoxMaxMm: [10, 10, 1], centerOfMassMm: [5, 5, 0.5], bodyRevisionId: "body-rev-1",
    },
  }],
  materials: [],
  entities: [{ kind: "body", id: "body-1", name: "Body", nativeToken: "body-1" }],
};

function readiness(): FusionReadinessDto {
  return {
    state: "ready",
    label: "Ready",
    diagnosis: "Fusion is ready.",
    endpoint,
    checkedAt: "2026-07-14T12:00:00.000Z",
    document,
    mutationAllowed: false,
  };
}

async function createFusionConversation(app: ReturnType<typeof createApp>) {
  const response = await app.request("/api/conversations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Inspect", cadEnvironment: "fusion" }),
  });
  return await response.json() as ConversationDto;
}

describe("Fusion inspection route", () => {
  it("persists stable revisions and marks older evidence stale after an engineering change", async () => {
    const captureInspection = vi.fn()
      .mockResolvedValueOnce({ snapshot: baseSnapshot, revision: "rev-a", screenshots: [], cameraRestored: true })
      .mockResolvedValueOnce({ snapshot: baseSnapshot, revision: "rev-a", screenshots: [], cameraRestored: true })
      .mockResolvedValueOnce({
        snapshot: { ...baseSnapshot, parameters: [{ ...baseSnapshot.parameters[0], valueMm: 90, expression: "90 mm" }] },
        revision: "rev-b",
        screenshots: [],
        cameraRestored: true,
      })
      .mockResolvedValueOnce({
        snapshot: { ...baseSnapshot, parameters: [{ ...baseSnapshot.parameters[0], valueMm: 90, expression: "90 mm" }] },
        revision: "rev-b",
        screenshots: [],
        cameraRestored: true,
      });
    const current = vi.fn().mockResolvedValue(readiness());
    const db = openDb(":memory:");
    const app = createApp(db, undefined, { fusionReadiness: { current, captureInspection } });
    const conversation = await createFusionConversation(app);
    await app.request(`/api/conversations/${conversation.id}/fusion-binding`, { method: "POST" });

    const inspect = () => app.request(`/api/conversations/${conversation.id}/fusion-inspections`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ checks: [{ kind: "body-count", expected: 1 }] }),
    });

    const first = await inspect();
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      current: { revision: "rev-a", stale: false, checks: [{ kind: "body-count", status: "passed" }] },
      history: [{ revision: "rev-a", stale: false }],
      earlierActionPlansStale: false,
      earlierCompletionEvidenceStale: false,
    });

    const repeated = await inspect();
    expect((await repeated.json()).history).toHaveLength(1);

    const changed = await inspect();
    expect(await changed.json()).toMatchObject({
      current: { revision: "rev-b", stale: false },
      history: [
        { revision: "rev-b", stale: false },
        { revision: "rev-a", stale: true },
      ],
      earlierActionPlansStale: true,
      earlierCompletionEvidenceStale: true,
      reconciliation: {
        precedingRevision: "rev-a",
        observedRevision: "rev-b",
        status: "reconciled",
        reason: "unambiguous-manual-edit",
        changes: [expect.objectContaining({ kind: "parameter", name: "width", change: "modified" })],
      },
    });

    const stableAfterChange = await inspect();
    expect(await stableAfterChange.json()).toMatchObject({
      current: { revision: "rev-b", stale: false },
      earlierActionPlansStale: true,
      earlierCompletionEvidenceStale: true,
    });
  });

  it("refuses inspection when the active document no longer matches the binding", async () => {
    const current = vi.fn()
      .mockResolvedValueOnce(readiness())
      .mockResolvedValue({ ...readiness(), document: { id: "other", name: "Other", dataFileId: "data-2" } });
    const captureInspection = vi.fn();
    const app = createApp(openDb(":memory:"), undefined, { fusionReadiness: { current, captureInspection } });
    const conversation = await createFusionConversation(app);
    await app.request(`/api/conversations/${conversation.id}/fusion-binding`, { method: "POST" });

    const response = await app.request(`/api/conversations/${conversation.id}/fusion-inspections`, { method: "POST" });

    expect(response.status).toBe(409);
    expect(captureInspection).not.toHaveBeenCalled();
  });

  it("does not label a completed Chamfer action revision as a manual edit", async () => {
    const changedSnapshot = { ...baseSnapshot, parameters: [{ ...baseSnapshot.parameters[0], valueMm: 90, expression: "90 mm" }] };
    const captureInspection = vi.fn()
      .mockResolvedValueOnce({ snapshot: baseSnapshot, revision: "rev-a", screenshots: [], cameraRestored: true })
      .mockResolvedValueOnce({ snapshot: changedSnapshot, revision: "rev-b", screenshots: [], cameraRestored: true });
    const db = openDb(":memory:");
    const app = createApp(db, undefined, { fusionReadiness: { current: vi.fn().mockResolvedValue(readiness()), captureInspection } });
    const conversation = await createFusionConversation(app);
    await app.request(`/api/conversations/${conversation.id}/fusion-binding`, { method: "POST" });
    await app.request(`/api/conversations/${conversation.id}/fusion-inspections`, { method: "POST" });
    db.prepare(`INSERT INTO fusion_action_ledger
      (id, conversation_id, action_id, event, recorded_at, document_json, expected_revision, observed_revision, final_revision,
       model_json, skills_json, policy_version, intent, body_sha256, affected_references_json, expected_effects_json, result_json, evidence_ids_json)
      VALUES ('ledger-action', ?, 'action', 'completed', 2, '{}', 'rev-a', 'rev-b', 'rev-b', '{}', '{}', 'v2',
       'change width', 'hash', '[]', '[]', '{"status":"completed"}', '[]')`).run(conversation.id);

    const response = await app.request(`/api/conversations/${conversation.id}/fusion-inspections`, { method: "POST" });
    expect(await response.json()).toMatchObject({ current: { revision: "rev-b" } });
    expect(db.prepare("SELECT 1 FROM fusion_reconciliation_ledger WHERE conversation_id = ?").get(conversation.id)).toBeUndefined();
  });

  it("returns degraded readiness when exact camera restoration fails", async () => {
    const current = vi.fn().mockResolvedValue(readiness());
    const captureInspection = vi.fn().mockResolvedValue({
      snapshot: baseSnapshot,
      revision: "rev-a",
      screenshots: [],
      cameraRestored: false,
    });
    const markCameraRestoration = vi.fn();
    const app = createApp(openDb(":memory:"), undefined, {
      fusionReadiness: { current, captureInspection, markCameraRestoration },
    });
    const conversation = await createFusionConversation(app);
    await app.request(`/api/conversations/${conversation.id}/fusion-binding`, { method: "POST" });

    const response = await app.request(`/api/conversations/${conversation.id}/fusion-inspections`, { method: "POST" });

    expect(await response.json()).toMatchObject({
      readiness: { state: "degraded", mutationAllowed: false },
      current: { cameraRestored: false },
    });
    expect(markCameraRestoration).toHaveBeenCalledWith(false);
  });

  it("uses a cheap fingerprint probe and returns full reconciliation evidence only after a manual change", async () => {
    const current = vi.fn().mockResolvedValue(readiness());
    const captureInspection = vi.fn().mockResolvedValue({ snapshot: baseSnapshot, revision: "rev-a", screenshots: [], cameraRestored: true });
    const changedSnapshot = { ...baseSnapshot, parameters: [{ ...baseSnapshot.parameters[0], valueMm: 95, expression: "95 mm" }] };
    const captureInspectionIfChanged = vi.fn()
      .mockResolvedValueOnce({ snapshot: changedSnapshot, revision: "rev-b", screenshots: [], cameraRestored: true })
      .mockResolvedValueOnce(undefined);
    const app = createApp(openDb(":memory:"), undefined, { fusionReadiness: { current, captureInspection, captureInspectionIfChanged } });
    const conversation = await createFusionConversation(app);
    await app.request(`/api/conversations/${conversation.id}/fusion-binding`, { method: "POST" });
    await app.request(`/api/conversations/${conversation.id}/fusion-inspections`, { method: "POST" });

    const changed = await app.request(`/api/conversations/${conversation.id}/fusion-reconciliation`, { method: "POST" });
    expect(await changed.json()).toMatchObject({ changed: true, inspection: {
      current: { revision: "rev-b" }, reconciliation: { status: "reconciled", precedingRevision: "rev-a", observedRevision: "rev-b" },
    } });
    // An unchanged poll stays a cheap fingerprint probe (no capture), but it
    // still echoes the authoritative revision and the persisted reconciliation
    // so a browser that lost the race to an agent-tool inspection can react.
    const unchanged = await app.request(`/api/conversations/${conversation.id}/fusion-reconciliation`, { method: "POST" });
    expect(await unchanged.json()).toMatchObject({
      changed: false,
      revision: "rev-b",
      reconciliation: { status: "reconciled", precedingRevision: "rev-a", observedRevision: "rev-b" },
    });
    expect(captureInspectionIfChanged).toHaveBeenNthCalledWith(1, document, "rev-a");
    expect(captureInspectionIfChanged).toHaveBeenNthCalledWith(2, document, "rev-b");
  });
});
