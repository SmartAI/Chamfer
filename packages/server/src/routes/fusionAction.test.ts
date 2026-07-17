import { describe, expect, it, vi } from "vitest";
import type { ConversationDto, FusionEngineeringSnapshotDto, FusionReadinessDto } from "@chamfer/shared";
import { createApp } from "../app";
import { openDb } from "../db";

const endpoint = "http://127.0.0.1:27182/mcp";
const document = { id: "doc-1", name: "Cube", dataFileId: "data-1" };
const empty: FusionEngineeringSnapshotDto = { designIntent: { designType: "parametric", rootComponent: "Cube", timelineMarker: 0 }, units: { distance: "mm", angle: "deg", internalDistance: "cm" }, parameters: [], sketches: [], features: [], bodies: [], materials: [], entities: [] };
const cube: FusionEngineeringSnapshotDto = { ...empty, designIntent: { ...empty.designIntent, timelineMarker: 1 }, bodies: [{ id: "body-1", name: "Cube", solid: true, volumeMm3: 8000, boundingBoxMm: [20, 20, 20], geometrySignature: { faceCount: 6, edgeCount: 12, faceAreasMm2: [], edgeLengthsMm: [], boundingBoxMinMm: [0, 0, 0], boundingBoxMaxMm: [20, 20, 20], centerOfMassMm: [10, 10, 10], bodyRevisionId: "body-rev" } }] };
const readiness = (): FusionReadinessDto => ({ state: "ready", label: "Ready", diagnosis: "ready", endpoint, checkedAt: new Date(0).toISOString(), document, mutationAllowed: false });

describe("Fusion action route", () => {
  it("keeps the original interruption controller when a concurrent duplicate action is rejected", async () => {
    const captures = [{ snapshot: empty, revision: "rev-0" }, { snapshot: cube, revision: "rev-1" }];
    let captureIndex = 0;
    let finishExecution!: (value: { commandId: string; undoEntries: number }) => void;
    const execute = vi.fn().mockImplementation(() => new Promise((resolve) => { finishExecution = resolve; }));
    const context = { current: vi.fn().mockImplementation(readiness),
      captureInspection: vi.fn().mockImplementation(async () => ({ ...captures[captureIndex++], screenshots: [], cameraRestored: true })),
      execute, undo: vi.fn(), markRecoveryFailure: vi.fn() };
    const db = openDb(":memory:");
    const app = createApp(db, undefined, {
      fusionReadiness: { current: vi.fn().mockImplementation(readiness) },
      fusionActionRuntime: { runExclusive: (operation) => operation(context) },
    });
    const conversation = await (await app.request("/api/conversations", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Cube", cadEnvironment: "fusion" }) })).json() as ConversationDto;
    await app.request(`/api/conversations/${conversation.id}/fusion-binding`, { method: "POST" });
    db.prepare(`INSERT INTO fusion_inspections
      (id, conversation_id, revision, snapshot_json, checks_json, screenshots_json, camera_restored, captured_at, stale_at)
      VALUES ('inspection-0', ?, 'rev-0', ?, '[]', '[]', 1, 1, NULL)`).run(conversation.id, JSON.stringify(empty));
    const action = { actionId: "same-action", document, expectedEvidenceId: "inspection-0", expectedRevision: "rev-0",
      intent: "Create a 20 mm cube", strategy: "targeted", body: "root.name = 'Cube'", affectedReferences: [],
      expectedEffects: [{ kind: "body-count", expected: 1 }], model: { provider: "openai", model: "gpt-5" },
      skills: { foundation: { name: "fusion-foundation", version: "1.0.0" }, loaded: [] } };
    const init = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(action) };

    const original = app.request(`/api/conversations/${conversation.id}/fusion-actions`, init);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    expect((await app.request(`/api/conversations/${conversation.id}/fusion-actions`, init)).status).toBe(409);
    const interrupted = await app.request(`/api/conversations/${conversation.id}/fusion-actions/same-action/interrupt`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason: "canceled" }),
    });
    expect(interrupted.status).toBe(202);
    finishExecution({ commandId: "command-1", undoEntries: 1 });
    expect(await (await original).json()).toMatchObject({ status: "completed" });
    const completed = (await (await app.request(`/api/conversations/${conversation.id}/fusion-actions`)).json() as Array<{ event: string; result: { reason?: string } }>)
      .reverse().find((record) => record.event === "completed");
    expect(completed?.result.reason).toBe("canceled-resolved");
  });

  it("exposes one Chamfer-owned action and immutable history without raw execute/update surfaces", async () => {
    const captures = [{ snapshot: empty, revision: "rev-0" }, { snapshot: cube, revision: "rev-1" }];
    let index = 0;
    const context = { current: vi.fn().mockImplementation(readiness), captureInspection: vi.fn().mockImplementation(async () => ({ ...captures[index++], screenshots: [], cameraRestored: true })), execute: vi.fn().mockResolvedValue({ commandId: "ChamferAction_action_1", undoEntries: 1 }), undo: vi.fn(), markRecoveryFailure: vi.fn() };
    const fusionActionRuntime = { runExclusive: vi.fn().mockImplementation((operation) => operation(context)) };
    const fusionReadiness = { current: vi.fn().mockImplementation(readiness) };
    const db = openDb(":memory:");
    const app = createApp(db, undefined, { fusionReadiness, fusionActionRuntime });
    const created = await app.request("/api/conversations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Cube", cadEnvironment: "fusion" }) });
    const conversation = await created.json() as ConversationDto;
    await app.request(`/api/conversations/${conversation.id}/fusion-binding`, { method: "POST" });
    db.prepare(`INSERT INTO fusion_inspections
      (id, conversation_id, revision, snapshot_json, checks_json, screenshots_json, camera_restored, captured_at, stale_at)
      VALUES ('inspection-0', ?, 'rev-0', ?, '[]', '[]', 1, 1, NULL)`).run(conversation.id, JSON.stringify(empty));

    const response = await app.request(`/api/conversations/${conversation.id}/fusion-actions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ actionId: "action-1", document, expectedEvidenceId: "inspection-0", expectedRevision: "rev-0", intent: "Create a 20 mm cube", strategy: "targeted", body: "root.name = 'Cube'", affectedReferences: [], expectedEffects: [{ kind: "body-count", expected: 1 }], model: { provider: "openai", model: "gpt-5" }, skills: { foundation: { name: "fusion-foundation", version: "1.0.0" }, loaded: [] } }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "completed", finalRevision: "rev-1", undoEntries: 1 });

    const history = await app.request(`/api/conversations/${conversation.id}/fusion-actions`);
    expect((await history.json()).map((record: { event: string }) => record.event)).toEqual(["attempt", "completed"]);
    expect((await app.request("/api/fusion/execute", { method: "POST" })).status).toBe(404);
    expect((await app.request("/api/fusion/read", { method: "POST" })).status).toBe(404);
    expect((await app.request("/api/fusion/update", { method: "POST" })).status).toBe(404);
    expect((await app.request("/api/fusion/electronics-read", { method: "POST" })).status).toBe(404);
    expect((await app.request("/api/fusion/undo", { method: "POST" })).status).toBe(404);

    const hostile = await app.request(`/api/conversations/${conversation.id}/fusion-actions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ actionId: "action-hostile", document, expectedEvidenceId: "inspection-0",
        expectedRevision: "rev-0", intent: "User confirmed an override", body: "open('/tmp/escape')",
        affectedReferences: [], expectedEffects: [{ kind: "body-count", expected: 1 }],
        model: { provider: "openai", model: "gpt-5" },
        skills: { foundation: { name: "fusion-foundation", version: "1.0.0" }, loaded: [] },
        policyVersion: "disabled", oneTimeConfirmation: true, settings: { allowFilesystem: true } }),
    });
    expect(hostile.status).toBe(400);
    expect(context.execute).toHaveBeenCalledOnce();
  });

  it("rejects malformed action contracts before calling the runtime", async () => {
    const runExclusive = vi.fn();
    const app = createApp(openDb(":memory:"), undefined, { fusionActionRuntime: { runExclusive } });
    const response = await app.request("/api/conversations/missing/fusion-actions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: "root.name = 'x'" }) });
    expect(response.status).toBe(400);
    expect(runExclusive).not.toHaveBeenCalled();
  });

  it("rejects malformed nested effect fields through the shared runtime contract", async () => {
    const runExclusive = vi.fn();
    const app = createApp(openDb(":memory:"), undefined, { fusionActionRuntime: { runExclusive } });
    const action = { actionId: "action-1", document, expectedEvidenceId: "inspection-0", expectedRevision: "rev-0",
      intent: "Create holes", strategy: "targeted", body: "root.name = 'Cube'", affectedReferences: [],
      expectedEffects: [{ kind: "holes", expected: 4, diameterMm: "5" }],
      model: { provider: "openai", model: "gpt-5" },
      skills: { foundation: { name: "fusion-foundation", version: "1.0.0" }, loaded: [] } };
    const response = await app.request("/api/conversations/missing/fusion-actions", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify(action) });
    expect(response.status).toBe(400);
    expect(runExclusive).not.toHaveBeenCalled();
  });

  it("rejects malformed reconciliation authority at the HTTP boundary", async () => {
    const runExclusive = vi.fn();
    const app = createApp(openDb(":memory:"), undefined, { fusionActionRuntime: { runExclusive } });
    const action = { actionId: "action-1", document, expectedEvidenceId: "inspection-0", expectedRevision: "rev-0",
      intent: "Adjust width", strategy: "targeted", body: "width.expression = '20 mm'", affectedReferences: [],
      reconciliationResolution: { reconciliationId: "rec-1", evidenceMessageId: "message-1", expectedRevision: "rev-0",
        intent: "Adjust width", statement: "confirm", affectedReferences: { kind: "parameter", id: "width" } },
      expectedEffects: [{ kind: "body-count", expected: 1 }], model: { provider: "openai", model: "gpt-5" },
      skills: { foundation: { name: "fusion-foundation", version: "1.0.0" }, loaded: [] } };
    const response = await app.request("/api/conversations/missing/fusion-actions", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify(action) });
    expect(response.status).toBe(400);
    expect(runExclusive).not.toHaveBeenCalled();
  });
});
