import { describe, expect, it } from "vitest";
import type { FusionEngineeringSnapshotDto, FusionInspectionRecordDto } from "@chamfer/shared";
import { reconcileFusionSnapshots } from "./reconciliation";
import { recordFusionReconciliation } from "./reconciliationStore";
import { openDb } from "../db";
import { createConversation } from "../conversationStore";

function snapshot(width: number): FusionEngineeringSnapshotDto {
  return {
    designIntent: { designType: "parametric", rootComponent: "Bracket", timelineMarker: 3 },
    units: { distance: "mm", angle: "deg", internalDistance: "cm" },
    parameters: [{ id: "chamfer:11111111-1111-4111-8111-111111111111", name: "width", expression: `${width} mm`, valueMm: width, unit: "mm" }],
    sketches: [{ id: "chamfer:22222222-2222-4222-8222-222222222222", name: "Base", plane: "XY", profiles: 1, curves: 4, constraints: ["HorizontalConstraint"], geometry: [], constraintDetails: [] }],
    features: [{ id: "chamfer:33333333-3333-4333-8333-333333333333", name: "Base extrude", type: "ExtrudeFeature", timelineIndex: 1, suppressed: false }],
    bodies: [{
      id: "chamfer:44444444-4444-4444-8444-444444444444", name: "Bracket", solid: true, volumeMm3: width * 100,
      boundingBoxMm: [width, 10, 10], material: "Aluminum 6061", appearance: "Blue anodized",
      geometrySignature: { faceCount: 6, edgeCount: 12, faceAreasMm2: [], edgeLengthsMm: [], boundingBoxMinMm: [0, 0, 0], boundingBoxMaxMm: [width, 10, 10], centerOfMassMm: [width / 2, 5, 5], bodyRevisionId: `body-${width}` },
    }],
    materials: [{ id: "al-6061", name: "Aluminum 6061" }],
    entities: [
      { kind: "parameter", id: "chamfer:11111111-1111-4111-8111-111111111111", chamferId: "11111111-1111-4111-8111-111111111111", name: "width", nativeToken: `width-${width}`, semanticDescriptor: "parameter:width" },
      { kind: "sketch", id: "chamfer:22222222-2222-4222-8222-222222222222", chamferId: "22222222-2222-4222-8222-222222222222", name: "Base", nativeToken: `sketch-${width}`, semanticDescriptor: "sketch:Base@XY" },
      { kind: "feature", id: "chamfer:33333333-3333-4333-8333-333333333333", chamferId: "33333333-3333-4333-8333-333333333333", name: "Base extrude", nativeToken: `feature-${width}`, semanticDescriptor: "feature:ExtrudeFeature:Base extrude" },
      { kind: "body", id: "chamfer:44444444-4444-4444-8444-444444444444", chamferId: "44444444-4444-4444-8444-444444444444", name: "Bracket", nativeToken: `body-${width}`, semanticDescriptor: "body:Bracket" },
    ],
  };
}

describe("Fusion manual-edit reconciliation", () => {
  it("accepts an unambiguous authoritative parameter change and refreshes stable references", () => {
    const result = reconcileFusionSnapshots(snapshot(20), snapshot(30), [{ id: "chamfer:11111111-1111-4111-8111-111111111111", kind: "parameter" }]);

    expect(result).toMatchObject({
      status: "reconciled",
      refreshedReferences: [{ id: "chamfer:11111111-1111-4111-8111-111111111111", kind: "parameter", nativeToken: "width-30" }],
    });
    expect(result.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "parameter", entityId: "chamfer:11111111-1111-4111-8111-111111111111", change: "modified" }),
    ]));
    expect(result.summary).toContain("width");
    expect(result.summary).not.toMatch(/code|script/i);
  });

  it("escalates when a referenced high-level entity disappears or identity resolves more than once", () => {
    const missing = snapshot(30);
    missing.entities = missing.entities.filter((entity) => entity.kind !== "parameter");
    expect(reconcileFusionSnapshots(snapshot(20), missing, [{ id: "chamfer:11111111-1111-4111-8111-111111111111", kind: "parameter" }]))
      .toMatchObject({ status: "needs-user", reason: "referenced-entity-missing" });

    const duplicate = snapshot(30);
    duplicate.entities.push({ ...duplicate.entities[0]!, nativeToken: "duplicate-token" });
    expect(reconcileFusionSnapshots(snapshot(20), duplicate, [{ id: "chamfer:11111111-1111-4111-8111-111111111111", kind: "parameter" }]))
      .toMatchObject({ status: "needs-user", reason: "ambiguous-entity-identity" });
  });

  it("escalates active requirement conflicts but reconciles unreferenced structural edits", () => {
    expect(reconcileFusionSnapshots(snapshot(20), snapshot(30), [], [{
      kind: "dimensions", status: "failed", detail: "Width must remain 20 mm.",
    }])).toMatchObject({ status: "needs-user", reason: "active-check-conflict" });

    // A manual feature removal nothing depends on - no active reference, no
    // failing refreshed check - is the user's authoritative design work and
    // reconciles automatically instead of stalling on a confirm string.
    const withoutFeature = snapshot(20);
    withoutFeature.features = [];
    withoutFeature.entities = withoutFeature.entities.filter((entity) => entity.kind !== "feature");
    expect(reconcileFusionSnapshots(snapshot(20), withoutFeature))
      .toMatchObject({ status: "reconciled", reason: "unambiguous-manual-edit" });
  });

  it("records a recurring fingerprint as a new transition occurrence", () => {
    const db = openDb(":memory:");
    const conversation = createConversation(db, "Fusion", "fusion");
    const inspection = (id: string, revision: string, width: number): FusionInspectionRecordDto => ({
      id, revision, snapshot: snapshot(width), checks: [], screenshots: [], cameraRestored: true, capturedAt: width, stale: false,
    });
    const a = inspection("a", "rev-a", 20);
    const b = inspection("b", "rev-b", 30);
    const c = inspection("c", "rev-c", 40);
    const document = { id: "doc", name: "Bracket" };

    const first = recordFusionReconciliation(db, conversation.id, document, a, b, [], [], 1);
    recordFusionReconciliation(db, conversation.id, document, b, c, [], [], 2);
    const recurring = recordFusionReconciliation(db, conversation.id, document, c, b, [], [], 3);
    const repeatedPoll = recordFusionReconciliation(db, conversation.id, document, c, b, [], [], 4);

    expect(recurring.id).not.toBe(first.id);
    expect(repeatedPoll.id).toBe(recurring.id);
    expect(db.prepare("SELECT COUNT(*) AS count FROM fusion_reconciliation_ledger").get()).toEqual({ count: 3 });
  });
});
