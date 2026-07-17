import { describe, expect, it, vi } from "vitest";
import type {
  ConversationDto, FusionActionRequestDto, FusionEngineeringSnapshotDto,
  FusionReadinessDto,
} from "@chamfer/shared";
import { openDb } from "../db";
import { createConversation, createMessage } from "../conversationStore";
import { insertFusionBinding } from "./ownershipStore";
import { FusionActionError, FusionActions, type FusionActionRuntime } from "./action";
import {
  appendFusionActionLedger, latestCompletedFusionOperationalContext, recordFusionActionOperationalContext,
} from "./actionLedger";
import { currentFusionRecovery } from "./recoveryStore";

const endpoint = "http://127.0.0.1:27182/mcp";
const document = { id: "creation-1", name: "Block", dataFileId: "data-1" };
const snapshot = (bodyCount: number): FusionEngineeringSnapshotDto => ({
  designIntent: { designType: "parametric", rootComponent: "Block", timelineMarker: bodyCount },
  units: { distance: "mm", angle: "deg", internalDistance: "cm" }, parameters: [], sketches: [], features: [],
  bodies: Array.from({ length: bodyCount }, (_, index) => ({
    id: `body-${index}`, name: `Body ${index}`, solid: true, volumeMm3: 8000,
    boundingBoxMm: [20, 20, 20], geometrySignature: {
      faceCount: 6, edgeCount: 12, faceAreasMm2: [], edgeLengthsMm: [], boundingBoxMinMm: [0, 0, 0],
      boundingBoxMaxMm: [20, 20, 20], centerOfMassMm: [10, 10, 10], bodyRevisionId: `body-rev-${bodyCount}`,
    },
  })),
  materials: [], entities: [{ kind: "component", id: "root-component", name: "Block", nativeToken: "root-token" }],
});

const ready = (): FusionReadinessDto => ({
  state: "ready", label: "Ready", diagnosis: "ready", endpoint, checkedAt: new Date(0).toISOString(),
  document, mutationAllowed: false,
});

function request(overrides: Partial<FusionActionRequestDto> = {}): FusionActionRequestDto {
  return {
    actionId: "action-1", document, expectedEvidenceId: "inspection-expected", expectedRevision: "rev-before", intent: "Create one 20 mm cube",
    strategy: "targeted",
    body: [
      "import adsk.core",
      "import adsk.fusion",
      "profile = references['profile']",
      "distance = adsk.core.ValueInput.createByString('20 mm')",
      "root.features.extrudeFeatures.addSimple(profile, distance, adsk.fusion.FeatureOperations.NewBodyFeatureOperation)",
    ].join("\n"), affectedReferences: [],
    expectedEffects: [{ kind: "body-count", expected: 1 }],
    model: { provider: "openai", model: "gpt-5" },
    skills: { foundation: { name: "fusion-foundation", version: "1.0.0" }, loaded: [] },
    ...overrides,
  };
}

function setup(captures: Array<{ snapshot: FusionEngineeringSnapshotDto; revision: string; cameraRestored?: boolean }>) {
  const db = openDb(":memory:");
  const conversation = createConversation(db, "Fusion", "fusion") as ConversationDto;
  insertFusionBinding(db, conversation.id, endpoint, document, "owner", 1);
  db.prepare(`INSERT INTO fusion_inspections
    (id, conversation_id, revision, snapshot_json, checks_json, screenshots_json, camera_restored, captured_at, stale_at)
    VALUES ('inspection-expected', ?, 'rev-before', ?, '[]', '[]', 1, 1, NULL)`)
    .run(conversation.id, JSON.stringify(snapshot(0)));
  let captureIndex = 0;
  const context = {
    current: vi.fn().mockImplementation(ready),
    captureInspection: vi.fn().mockImplementation(async () => {
      const capture = captures[captureIndex++];
      return { ...capture, screenshots: [], cameraRestored: capture?.cameraRestored ?? true };
    }),
    diagnose: vi.fn().mockRejectedValue(new Error("read-only diagnosis unavailable")),
    execute: vi.fn().mockResolvedValue({ commandId: "Chamfer_action_1", undoEntries: 1 }),
    undo: vi.fn().mockResolvedValue(undefined),
    markRecoveryFailure: vi.fn(),
  };
  const runtime: FusionActionRuntime = { runExclusive: (operation) => operation(context) };
  return { db, conversation, context, actions: new FusionActions(db, runtime) };
}

describe("Fusion atomic actions", () => {
  it("holds one runtime lease across revision inspection, one command, and independent verification", async () => {
    const { actions, context, conversation, db } = setup([
      { snapshot: snapshot(0), revision: "rev-before" },
      { snapshot: snapshot(1), revision: "rev-after" },
    ]);

    const result = await actions.execute(conversation.id, request());

    expect(result).toMatchObject({ status: "completed", precedingRevision: "rev-before", finalRevision: "rev-after", undoEntries: 1 });
    expect(context.execute).toHaveBeenCalledOnce();
    expect(context.undo).not.toHaveBeenCalled();
    expect(actions.history(conversation.id).map((record) => record.event)).toEqual(["attempt", "completed"]);
    expect(actions.history(conversation.id)[0]?.result.strategy).toBe("targeted");
  });

  it("keeps a verified native mutation completed when auxiliary artifact persistence fails", async () => {
    const { actions, context, conversation, db } = setup([
      { snapshot: snapshot(0), revision: "rev-before" },
      { snapshot: snapshot(1), revision: "rev-after" },
    ]);
    db.exec(`CREATE TRIGGER reject_fusion_artifact BEFORE INSERT ON artifacts
      WHEN NEW.py_source LIKE 'fusion-revision:%'
      BEGIN SELECT RAISE(FAIL, 'synthetic artifact unavailable'); END`);

    const result = await actions.execute(conversation.id, request());

    expect(result).toMatchObject({ status: "completed", finalRevision: "rev-after" });
    expect(result.visualArtifact).toBeUndefined();
    expect(context.undo).not.toHaveBeenCalled();
    expect(actions.history(conversation.id).map((record) => record.event)).toEqual(["attempt", "completed"]);
  });

  it("undoes exactly once when the result is structurally broken and restores the preceding revision", async () => {
    const { actions, context, conversation } = setup([
      { snapshot: snapshot(0), revision: "rev-before" },
      { snapshot: snapshot(0), revision: "rev-bad" },
      { snapshot: snapshot(0), revision: "rev-before" },
    ]);

    const result = await actions.execute(conversation.id, request());

    expect(result).toMatchObject({ status: "rolled-back", finalRevision: "rev-before", undoEntries: 0 });
    expect(context.undo).toHaveBeenCalledOnce();
    expect(actions.history(conversation.id).map((record) => record.event)).toEqual(["attempt", "rollback", "completed"]);
  });

  it("does not accept vacuous solid integrity when declared effects otherwise pass", async () => {
    const { actions, context, conversation } = setup([
      { snapshot: snapshot(0), revision: "rev-before" },
      { snapshot: snapshot(0), revision: "rev-empty" },
      { snapshot: snapshot(0), revision: "rev-before" },
    ]);
    const result = await actions.execute(conversation.id, request({ expectedEffects: [{ kind: "body-count", expected: 0 }] }));
    expect(result.status).toBe("rolled-back");
    expect(context.undo).toHaveBeenCalledOnce();
  });

  it("retains structurally sound geometry when a declared effect misses, reporting the failure informationally", async () => {
    const { actions, context, conversation } = setup([
      { snapshot: snapshot(0), revision: "rev-before" },
      { snapshot: snapshot(1), revision: "rev-kept" },
    ]);
    // Declared effects are the agent's own predictions. Grading them per action
    // rolled back geometrically correct features whenever the prediction's
    // arithmetic was wrong (observed live: an exactly correct 6 mm shell undone
    // over a ~41% mis-predicted volume band, ending in a false "blocked by
    // Fusion" claim). A missed declared effect is now reported with the measured
    // value and the geometry stays; binding verification happens only at the
    // final plan completion inspection.
    const result = await actions.execute(conversation.id, request({ expectedEffects: [{ kind: "feature", featureType: "FilletFeature", minCount: 1 }] }));
    expect(result).toMatchObject({ status: "completed", finalRevision: "rev-kept", undoEntries: 1 });
    expect(context.undo).not.toHaveBeenCalled();
    expect(result.checks).toContainEqual(expect.objectContaining({ kind: "feature", status: "failed" }));
    expect(actions.history(conversation.id).map((record) => record.event)).toEqual(["attempt", "completed"]);
  });

  it("retains a split solid and reports the body-count mismatch for targeted repair", async () => {
    const { actions, context, conversation } = setup([
      { snapshot: snapshot(0), revision: "rev-before" },     // before: empty design
      { snapshot: snapshot(2), revision: "rev-split" },      // after: 2 bodies, but 1 declared
    ]);
    const result = await actions.execute(conversation.id, request({ expectedEffects: [{ kind: "body-count", expected: 1 }] }));
    expect(result).toMatchObject({ status: "completed", finalRevision: "rev-split", undoEntries: 1 });
    expect(context.undo).not.toHaveBeenCalled();
    expect(result.checks).toContainEqual(expect.objectContaining({ kind: "body-count", status: "failed" }));
  });

  it("completes with a reported camera failure when camera restoration fails", async () => {
    const degraded = setup([
      { snapshot: snapshot(0), revision: "rev-before" },
      { snapshot: snapshot(1), revision: "rev-after", cameraRestored: false },
    ]);

    const result = await degraded.actions.execute(degraded.conversation.id, request());

    expect(result).toMatchObject({ status: "completed", finalRevision: "rev-after", undoEntries: 1 });
    expect(degraded.context.undo).not.toHaveBeenCalled();
    expect(result.inspection.current.checks).toContainEqual(expect.objectContaining({
      kind: "camera-restoration", status: "failed",
    }));
  });

  it("reconnects only for read-only diagnosis after a mutation disconnect and never retries the mutation", async () => {
    const disconnected = setup([{ snapshot: snapshot(0), revision: "rev-before" }]);
    disconnected.context.execute.mockRejectedValueOnce(new Error("socket disconnected"));
    disconnected.context.diagnose = vi.fn().mockResolvedValue({ snapshot: snapshot(0), revision: "rev-before", screenshots: [], cameraRestored: true });

    await expect(disconnected.actions.execute(disconnected.conversation.id, request()))
      .rejects.toMatchObject({ reason: "disconnect-no-change" });

    expect(disconnected.context.execute).toHaveBeenCalledOnce();
    expect(disconnected.context.diagnose).toHaveBeenCalledOnce();
    expect(disconnected.context.undo).not.toHaveBeenCalled();
    expect(disconnected.context.markRecoveryFailure).not.toHaveBeenCalled();
    expect(currentFusionRecovery(disconnected.db, endpoint)).toBeUndefined();
    expect(disconnected.db.prepare("SELECT state, failure_class FROM fusion_recovery_ledger ORDER BY rowid").all())
      .toEqual([{ state: "diagnosing", failure_class: "disconnect" }, { state: "resolved", failure_class: "disconnect" }]);
  });

  it("records cancellation during mutation but keeps executing until trusted inspection establishes the result", async () => {
    const canceled = setup([
      { snapshot: snapshot(0), revision: "rev-before" },
      { snapshot: snapshot(1), revision: "rev-after" },
    ]);
    const controller = new AbortController();
    canceled.context.execute.mockImplementationOnce(async () => {
      controller.abort(new DOMException("The user canceled the request", "AbortError"));
      return { commandId: "Chamfer_action_1", undoEntries: 1 };
    });

    await expect(canceled.actions.execute(canceled.conversation.id, request(), controller.signal))
      .resolves.toMatchObject({ status: "completed", finalRevision: "rev-after" });

    expect(currentFusionRecovery(canceled.db, endpoint)).toBeUndefined();
    expect(canceled.db.prepare("SELECT state, failure_class FROM fusion_recovery_ledger ORDER BY rowid").all())
      .toEqual([{ state: "diagnosing", failure_class: "canceled" }, { state: "resolved", failure_class: "canceled" }]);
  });

  it("treats a request timeout as uncertain until the in-flight mutation is inspected", async () => {
    const timedOut = setup([
      { snapshot: snapshot(0), revision: "rev-before" },
      { snapshot: snapshot(1), revision: "rev-after" },
    ]);
    const controller = new AbortController();
    timedOut.context.execute.mockImplementationOnce(async () => {
      controller.abort(new DOMException("The Fusion action timed out", "TimeoutError"));
      return { commandId: "Chamfer_action_1", undoEntries: 1 };
    });

    await expect(timedOut.actions.execute(timedOut.conversation.id, request(), controller.signal))
      .resolves.toMatchObject({ status: "completed", finalRevision: "rev-after" });
    expect(timedOut.db.prepare("SELECT state, failure_class FROM fusion_recovery_ledger ORDER BY rowid").all())
      .toEqual([{ state: "diagnosing", failure_class: "timeout" }, { state: "resolved", failure_class: "timeout" }]);
  });

  it("preserves the interruption class when trusted rollback resolves recovery", async () => {
    const canceled = setup([
      { snapshot: snapshot(0), revision: "rev-before" },
      { snapshot: snapshot(0), revision: "rev-bad" },
      { snapshot: snapshot(0), revision: "rev-before" },
    ]);
    const controller = new AbortController();
    canceled.context.execute.mockImplementationOnce(async () => {
      controller.abort(new DOMException("The user canceled the request", "AbortError"));
      return { commandId: "Chamfer_action_1", undoEntries: 1 };
    });

    await expect(canceled.actions.execute(canceled.conversation.id, request(), controller.signal))
      .resolves.toMatchObject({ status: "rolled-back", finalRevision: "rev-before" });
    expect(canceled.db.prepare("SELECT state, failure_class FROM fusion_recovery_ledger ORDER BY rowid").all())
      .toEqual([{ state: "diagnosing", failure_class: "canceled" }, { state: "resolved", failure_class: "canceled" }]);
  });

  it("isolates identical operational action identities by conversation", () => {
    const db = openDb(":memory:");
    const first = createConversation(db, "First", "fusion");
    const second = createConversation(db, "Second", "fusion");
    const firstRequest = request({ affectedReferences: [{ id: "first", kind: "body" }] });
    const secondRequest = request({ affectedReferences: [{ id: "second", kind: "body" }] });
    for (const [conversation, actionRequest] of [[first, firstRequest], [second, secondRequest]] as const) {
      recordFusionActionOperationalContext(db, conversation.id, actionRequest);
      appendFusionActionLedger(db, conversation.id, actionRequest, "test", "completed",
        { finalRevision: "rev-after", result: { status: "completed" } });
    }

    expect(latestCompletedFusionOperationalContext(db, first.id)?.affectedReferences).toEqual(firstRequest.affectedReferences);
    expect(latestCompletedFusionOperationalContext(db, second.id)?.affectedReferences).toEqual(secondRequest.affectedReferences);
  });

  it("rejects stale revisions and policy violations before mutation while retaining audit evidence", async () => {
    const stale = setup([{ snapshot: snapshot(0), revision: "different" }]);
    await expect(stale.actions.execute(stale.conversation.id, request())).rejects.toMatchObject({ status: 409 });
    expect(stale.context.execute).not.toHaveBeenCalled();
    // A revision-hash change with zero normalized engineering difference is
    // benign churn: the action is still rejected (re-inspect first), but it
    // reconciles automatically instead of demanding a user confirm string.
    expect(stale.actions.history(stale.conversation.id).at(-1)).toMatchObject({ event: "rejected", result: { reason: "stale-revision-reconciled" } });
    expect(stale.db.prepare("SELECT status, preceding_revision, observed_revision FROM fusion_reconciliation_ledger").get())
      .toMatchObject({ status: "reconciled", preceding_revision: "rev-before", observed_revision: "different" });

    const denied = setup([]);
    await expect(denied.actions.execute(denied.conversation.id, request({ body: "import os\nos.remove('/tmp/x')" })))
      .rejects.toBeInstanceOf(FusionActionError);
    expect(denied.context.current).not.toHaveBeenCalled();
    expect(denied.context.execute).not.toHaveBeenCalled();
    expect(denied.actions.history(denied.conversation.id).at(-1)).toMatchObject({ event: "rejected", result: { reason: "policy" } });
  });

  it("does not write raw MCP failure traffic or credentials to the action ledger", async () => {
    const denied = setup([{ snapshot: snapshot(0), revision: "rev-before" }]);
    denied.context.execute.mockRejectedValueOnce(new Error(
      'MCP 500 {"authorization":"Bearer top-secret","projectFiles":["unrelated.f3d"]}',
    ));
    await expect(denied.actions.execute(denied.conversation.id, request({
      actionId: "Bearer action-secret",
      intent: "Use credential Bearer top-secret while opening unrelated.f3d",
      model: { provider: "provider-secret", model: "model-secret" },
      skills: { foundation: { name: "skill-secret", version: "version-secret" }, loaded: [] },
      expectedEffects: [
        { kind: "material", expected: "material-secret" },
        { kind: "visual-evidence", requiredViews: ["isometric", "front"] },
      ],
    }))).rejects.toMatchObject({
      reason: "transaction-failure",
    });
    const serialized = JSON.stringify(denied.actions.history(denied.conversation.id));
    expect(serialized).not.toContain("top-secret");
    expect(serialized).not.toContain("unrelated.f3d");
    expect(serialized).not.toContain("authorization");
    for (const secret of ["action-secret", "provider-secret", "model-secret", "skill-secret", "version-secret", "material-secret"]) {
      expect(serialized).not.toContain(secret);
    }
    expect(denied.actions.history(denied.conversation.id)[0]?.intent).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(denied.actions.history(denied.conversation.id)[0]?.expectedEffects[1]).toEqual({
      kind: "visual-evidence",
      requiredViews: ["isometric", "front"],
    });
  });

  it("hashes untrusted document and reference strings before recording a rejected attempt", async () => {
    const denied = setup([{ snapshot: snapshot(0), revision: "rev-before" }]);
    await expect(denied.actions.execute(denied.conversation.id, request({
      actionId: "reference-privacy",
      document: { id: "doc-secret", name: "unrelated-secret.f3d", dataFileId: "file-secret" },
      affectedReferences: [{ id: "reference-secret", kind: "body" }],
    }))).rejects.toMatchObject({ reason: "wrong-document" });
    const serialized = JSON.stringify(denied.actions.history(denied.conversation.id));
    for (const secret of ["doc-secret", "unrelated-secret.f3d", "file-secret", "reference-secret"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("classifies an unambiguous stale parameter edit the same way before polling can win", async () => {
    const before = snapshot(0);
    before.parameters = [{ id: "parameter:width", name: "width", expression: "20 mm", valueMm: 20, unit: "mm" }];
    before.entities.push({ kind: "parameter", id: "parameter:width", name: "width", nativeToken: "width-20" });
    const after = structuredClone(before);
    after.parameters[0] = { ...after.parameters[0]!, expression: "30 mm", valueMm: 30 };
    after.entities.find((entity) => entity.kind === "parameter")!.nativeToken = "width-30";
    const stale = setup([{ snapshot: after, revision: "rev-manual" }]);
    stale.db.prepare("UPDATE fusion_inspections SET snapshot_json = ? WHERE id = 'inspection-expected'").run(JSON.stringify(before));

    await expect(stale.actions.execute(stale.conversation.id, request())).rejects
      .toMatchObject({ reason: "stale-revision-reconciled" });
    expect(stale.db.prepare("SELECT status, reason FROM fusion_reconciliation_ledger").get())
      .toMatchObject({ status: "reconciled", reason: "unambiguous-manual-edit" });
  });

  it("rolls back a targeted revision that changes unaffected feature intent", async () => {
    const before = snapshot(1);
    before.features = [{ id: "feature-base", name: "Base extrude", type: "ExtrudeFeature", timelineIndex: 0, suppressed: false }];
    before.entities.push({ kind: "feature", id: "feature-base", name: "Base extrude", nativeToken: "feature-before", semanticDescriptor: "feature:ExtrudeFeature:Base extrude" });
    const after = structuredClone(before);
    after.features[0]!.name = "Unexpected replacement";
    after.entities.find((entity) => entity.id === "feature-base")!.name = "Unexpected replacement";
    const { actions, context, conversation } = setup([
      { snapshot: before, revision: "rev-before" },
      { snapshot: after, revision: "rev-after" },
      { snapshot: before, revision: "rev-before" },
    ]);

    const result = await actions.execute(conversation.id, request({ affectedReferences: [] }));

    expect(result.status).toBe("rolled-back");
    expect(context.undo).toHaveBeenCalledOnce();
    expect(actions.history(conversation.id).find((record) => record.event === "rollback")?.result)
      .toMatchObject({ checks: expect.arrayContaining([expect.objectContaining({ kind: "intent-preservation", status: "failed" })]) });
  });

  it("requires explicit approval before destructive rebuild capabilities are allowed", async () => {
    const unapproved = setup([]);
    await expect(unapproved.actions.execute(unapproved.conversation.id, request({
      strategy: "destructive-rebuild",
      body: "references['body'].deleteMe()",
    }))).rejects.toMatchObject({ reason: "destructive-approval-required" });
    expect(unapproved.context.current).not.toHaveBeenCalled();

    const forged = setup([]);
    await expect(forged.actions.execute(forged.conversation.id, request({
      strategy: "destructive-rebuild",
      destructiveApproval: { basis: "explicit-approval", evidenceMessageId: "missing", expectedRevision: "rev-before", intent: "Create one 20 mm cube", statement: "Rebuild it." },
      body: "references['body'].deleteMe()",
    }))).rejects.toMatchObject({ reason: "destructive-approval-required" });

    const approved = setup([
      { snapshot: snapshot(0), revision: "rev-before" },
      { snapshot: snapshot(1), revision: "rev-after" },
    ]);
    const statement = "REQUEST FUSION REBUILD: Create one 20 mm cube";
    createMessage(approved.db, approved.conversation.id, { id: "approval-message", seq: 1, role: "user",
      contentJson: JSON.stringify({ role: "user", content: [{ type: "text", text: statement }] }) });
    await expect(approved.actions.execute(approved.conversation.id, request({
      strategy: "destructive-rebuild",
      destructiveApproval: { basis: "original-replacement-request", evidenceMessageId: "approval-message", expectedRevision: "rev-before", intent: "Create one 20 mm cube", statement },
      body: "references['body'].deleteMe()",
    }))).resolves.toMatchObject({ status: "completed" });

    const revoked = setup([]);
    createMessage(revoked.db, revoked.conversation.id, { id: "old-approval", seq: 1, role: "user",
      contentJson: JSON.stringify({ role: "user", content: [{ type: "text", text: statement }] }) });
    createMessage(revoked.db, revoked.conversation.id, { id: "later-instruction", seq: 2, role: "user",
      contentJson: JSON.stringify({ role: "user", content: [{ type: "text", text: "Preserve the current history." }] }) });
    await expect(revoked.actions.execute(revoked.conversation.id, request({
      strategy: "destructive-rebuild",
      destructiveApproval: { basis: "original-replacement-request", evidenceMessageId: "old-approval", expectedRevision: "rev-before", intent: "Create one 20 mm cube", statement },
      body: "references['body'].deleteMe()",
    }))).rejects.toMatchObject({ reason: "destructive-approval-required" });
  });

  it("records later user direction to resolve an ambiguous manual revision", async () => {
    const resolved = setup([
      { snapshot: snapshot(0), revision: "rev-before" },
      { snapshot: snapshot(1), revision: "rev-after" },
    ]);
    resolved.db.prepare(`INSERT INTO fusion_reconciliation_ledger
      (id, conversation_id, recorded_at, document_json, preceding_revision, observed_revision, status, reason,
       summary, changes_json, refreshed_references_json, refreshed_checks_json, evidence_id)
      VALUES ('needs-direction', ?, 1, '{}', 'rev-old', 'rev-before', 'needs-user', 'structural-edit-needs-user',
       'A feature changed.', '[]', '[]', '[]', 'inspection-expected')`).run(resolved.conversation.id);
    const statement = "CONFIRM FUSION RECONCILIATION needs-direction AT rev-before REFERENCES none: Create one 20 mm cube";
    createMessage(resolved.db, resolved.conversation.id, { id: "direction-message", seq: 1, role: "user",
      contentJson: JSON.stringify({ role: "user", content: [{ type: "text", text: statement }] }) });

    await expect(resolved.actions.execute(resolved.conversation.id, request({ reconciliationResolution: {
      reconciliationId: "needs-direction", evidenceMessageId: "direction-message", expectedRevision: "rev-before",
      intent: "Create one 20 mm cube", affectedReferences: [], statement,
    } })))
      .resolves.toMatchObject({ status: "completed" });
    expect(resolved.db.prepare("SELECT reconciliation_id, user_message_id FROM fusion_reconciliation_resolutions").get())
      .toMatchObject({ reconciliation_id: "needs-direction", user_message_id: "direction-message" });
  });

  it("keeps an ambiguous reconciliation blocked for unrelated or unscoped follow-ups", async () => {
    const blocked = setup([{ snapshot: snapshot(0), revision: "rev-before" }]);
    blocked.db.prepare(`INSERT INTO fusion_reconciliation_ledger
      (id, conversation_id, recorded_at, document_json, preceding_revision, observed_revision, status, reason,
       summary, changes_json, refreshed_references_json, refreshed_checks_json, evidence_id)
      VALUES ('needs-direction', ?, 1, '{}', 'rev-old', 'rev-before', 'needs-user', 'structural-edit-needs-user',
       'A feature changed.', '[]', '[]', '[]', 'inspection-expected')`).run(blocked.conversation.id);
    createMessage(blocked.db, blocked.conversation.id, { id: "question", seq: 1, role: "user",
      contentJson: JSON.stringify({ role: "user", content: [{ type: "text", text: "What changed?" }] }) });

    await expect(blocked.actions.execute(blocked.conversation.id, request()))
      .rejects.toMatchObject({ reason: "manual-edit-needs-user" });
    expect(blocked.db.prepare("SELECT COUNT(*) AS count FROM fusion_reconciliation_resolutions").get()).toEqual({ count: 0 });
  });

  it("does not reuse an older manual ambiguity when Chamfer produced the current revision", async () => {
    const current = setup([
      { snapshot: snapshot(0), revision: "rev-before" },
      { snapshot: snapshot(1), revision: "rev-after" },
    ]);
    current.db.prepare(`INSERT INTO fusion_reconciliation_ledger
      (id, conversation_id, recorded_at, document_json, preceding_revision, observed_revision, status, reason,
       summary, changes_json, refreshed_references_json, refreshed_checks_json, evidence_id)
      VALUES ('old-occurrence', ?, 1, '{}', 'rev-a', 'rev-before', 'needs-user', 'structural-edit-needs-user',
       'An older transition was ambiguous.', '[]', '[]', '[]', 'inspection-expected')`).run(current.conversation.id);
    appendFusionActionLedger(current.db, current.conversation.id, request({ actionId: "past-action" }), "test", "completed",
      { finalRevision: "rev-before", result: { status: "completed" } }, 2);

    await expect(current.actions.execute(current.conversation.id, request())).resolves.toMatchObject({ status: "completed" });
  });

  it("does not suppress a newer manual recurrence of a Chamfer-produced fingerprint", async () => {
    const recurring = setup([{ snapshot: snapshot(0), revision: "rev-before" }]);
    appendFusionActionLedger(recurring.db, recurring.conversation.id, request({ actionId: "past-action" }), "test", "completed",
      { finalRevision: "rev-before", result: { status: "completed" } }, 2);
    recurring.db.prepare(`INSERT INTO fusion_reconciliation_ledger
      (id, conversation_id, recorded_at, document_json, preceding_revision, observed_revision, status, reason,
       summary, changes_json, refreshed_references_json, refreshed_checks_json, evidence_id)
      VALUES ('new-occurrence', ?, 3, '{}', 'rev-c', 'rev-before', 'needs-user', 'structural-edit-needs-user',
       'The user manually returned to this fingerprint.', '[]', '[]', '[]', 'inspection-expected')`).run(recurring.conversation.id);

    await expect(recurring.actions.execute(recurring.conversation.id, request()))
      .rejects.toMatchObject({ reason: "manual-edit-needs-user" });
  });

  it("enters recovery when Undo cannot re-establish the preceding authoritative revision", async () => {
    const { actions, context, conversation, db } = setup([
      { snapshot: snapshot(0), revision: "rev-before" },
      { snapshot: snapshot(0), revision: "rev-bad" },
      { snapshot: snapshot(0), revision: "rev-uncertain" },
    ]);
    await expect(actions.execute(conversation.id, request())).rejects.toMatchObject({ status: 503 });
    expect(context.markRecoveryFailure).toHaveBeenCalledOnce();
    expect(actions.history(conversation.id).at(-1)).toMatchObject({ event: "failed", result: { reason: "rollback-revision-mismatch" } });
    expect(currentFusionRecovery(db, endpoint)).toMatchObject({
      state: "hard-recovery", failureClass: "revision-uncertain", allowedOperation: "inspect-resulting-state",
    });
  });

  it("persists hard recovery when the native transaction reports an invalid Undo count", async () => {
    const invalid = setup([{ snapshot: snapshot(0), revision: "rev-before" }]);
    invalid.context.execute.mockResolvedValueOnce({ commandId: "invalid", undoEntries: 2 });

    await expect(invalid.actions.execute(invalid.conversation.id, request()))
      .rejects.toMatchObject({ reason: "undo-entry-count" });
    expect(currentFusionRecovery(invalid.db, endpoint)).toMatchObject({
      state: "hard-recovery", failureClass: "revision-uncertain", allowedOperation: "inspect-resulting-state",
    });
    const restartedActions = new FusionActions(invalid.db, { runExclusive: vi.fn() });
    await expect(restartedActions.execute(invalid.conversation.id, request({ actionId: "after-restart" })))
      .rejects.toMatchObject({ reason: "recovery-unresolved" });
  });

  it("rejects an unavailable lease without inspecting or mutating Fusion", async () => {
    const { db, conversation } = setup([]);
    const actions = new FusionActions(db, { runExclusive: async () => { throw new FusionActionError("busy", 409, "lease-unavailable"); } });
    await expect(actions.execute(conversation.id, request())).rejects.toMatchObject({ status: 409 });
    expect(actions.history(conversation.id).at(-1)).toMatchObject({ event: "rejected" });
  });

  it("refuses duplicate action identities and database mutation of the append-only ledger", async () => {
    const { actions, context, conversation, db } = setup([
      { snapshot: snapshot(0), revision: "rev-before" }, { snapshot: snapshot(1), revision: "rev-after" },
    ]);
    await actions.execute(conversation.id, request());
    await expect(actions.execute(conversation.id, request())).rejects.toMatchObject({ reason: "duplicate-action" });
    expect(context.execute).toHaveBeenCalledOnce();
    expect(() => db.prepare("UPDATE fusion_action_ledger SET event = 'failed'").run()).toThrow(/immutable/);
    expect(() => db.prepare("DELETE FROM fusion_action_ledger").run()).toThrow(/immutable/);
  });
});

