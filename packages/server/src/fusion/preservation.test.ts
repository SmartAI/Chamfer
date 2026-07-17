import { describe, expect, it } from "vitest";
import type { FusionBodyDto, FusionEngineeringSnapshotDto } from "@chamfer/shared";
import { fusionIntentPreservationViolations } from "./preservation";

const ROOT = { kind: "component" as const, id: "root", name: "Root", nativeToken: "t-root" };

function body(id: string, name: string): FusionBodyDto {
  return {
    id, name, solid: true, volumeMm3: 1000, boundingBoxMm: [10, 10, 10],
    geometrySignature: {
      faceCount: 6, edgeCount: 12, faceAreasMm2: [], edgeLengthsMm: [],
      boundingBoxMinMm: [0, 0, 0], boundingBoxMaxMm: [10, 10, 10],
      centerOfMassMm: [5, 5, 5], bodyRevisionId: `rev-${id}`,
    },
  };
}

function snapshot(over: Partial<FusionEngineeringSnapshotDto> = {}): FusionEngineeringSnapshotDto {
  return {
    designIntent: { designType: "parametric", rootComponent: "Root", timelineMarker: 1 },
    units: { distance: "mm", angle: "deg", internalDistance: "cm" },
    parameters: [], sketches: [], features: [], bodies: [], materials: [],
    entities: [ROOT],
    ...over,
  };
}

const REGISTERED = (kind: "feature" | "sketch", id: string, name: string) => ({
  kind, id, name, nativeToken: `t-${id}`,
  chamferId: "550e8400-e29b-41d4-a716-446655440000", semanticDescriptor: `${kind}:${name}`,
});

describe("fusionIntentPreservationViolations", () => {
  it("passes an additive from-scratch build whose new entities are unregistered", () => {
    // Empty design (root component only). The action adds a base extrude plus the
    // model parameters Fusion auto-creates, none carrying a Chamfer UUID.
    const before = snapshot();
    const after = snapshot({
      parameters: [{ id: "p1", name: "base_thk", expression: "18 mm", valueMm: 18, unit: "mm" }],
      features: [{ id: "f1", name: "base", type: "ExtrudeFeature", timelineIndex: 0, suppressed: false }],
      bodies: [body("b1", "Solid")],
      entities: [
        ROOT,
        { kind: "parameter", id: "p1", name: "base_thk", nativeToken: "t-p1" },
        { kind: "feature", id: "f1", name: "base", nativeToken: "t-f1" },
        { kind: "body", id: "b1", name: "Solid", nativeToken: "t-b1" },
      ],
    });
    expect(fusionIntentPreservationViolations(before, after, [])).toEqual([]);
  });

  it("passes an additive action into an existing design (no affectedReferences)", () => {
    const before = snapshot({
      features: [{ id: "f1", name: "base", type: "ExtrudeFeature", timelineIndex: 0, suppressed: false }],
      bodies: [body("b1", "Solid")],
      entities: [ROOT, REGISTERED("feature", "f1", "base")],
    });
    // Adds a boss feature the model has not registered yet; a purely additive
    // action must not roll back over a missing UUID.
    const after = snapshot({
      features: [
        { id: "f1", name: "base", type: "ExtrudeFeature", timelineIndex: 0, suppressed: false },
        { id: "f2", name: "boss", type: "ExtrudeFeature", timelineIndex: 1, suppressed: false },
      ],
      bodies: [body("b1", "Solid")],
      entities: [ROOT, REGISTERED("feature", "f1", "base"), { kind: "feature", id: "f2", name: "boss", nativeToken: "t-f2" }],
    });
    expect(fusionIntentPreservationViolations(before, after, [])).toEqual([]);
  });

  it("flags a new unregistered feature during a targeted edit", () => {
    const before = snapshot({
      features: [{ id: "f1", name: "base", type: "ExtrudeFeature", timelineIndex: 0, suppressed: false }],
      bodies: [body("b1", "Solid")],
      entities: [ROOT, REGISTERED("feature", "f1", "base")],
    });
    const after = snapshot({
      features: [
        { id: "f1", name: "base", type: "ExtrudeFeature", timelineIndex: 0, suppressed: false },
        { id: "f2", name: "cut", type: "ExtrudeFeature", timelineIndex: 1, suppressed: false },
      ],
      bodies: [body("b1", "Solid")],
      entities: [ROOT, REGISTERED("feature", "f1", "base"), { kind: "feature", id: "f2", name: "cut", nativeToken: "t-f2" }],
    });
    const violations = fusionIntentPreservationViolations(before, after, [{ kind: "feature", id: "f1" }]);
    expect(violations.some((message) => message.includes("lacks a namespaced UUID identity"))).toBe(true);
  });

  it("exempts auto-generated model parameters when their owning feature is deliberately replaced", () => {
    // Deleting a declared feature also deletes the d-parameters Fusion
    // auto-created for its dimensions. The agent cannot declare those (they are
    // not registered entities); holding them to the contract deadlocked every
    // legitimate delete-and-re-author (observed live: "unaffected parameter d7
    // was removed"). User-named parameters stay protected.
    const before = snapshot({
      parameters: [
        { id: "p-d7", name: "d7", expression: "6 mm", valueMm: 6, unit: "mm" },
        { id: "p-user", name: "wall_thk", expression: "6 mm", valueMm: 6, unit: "mm" },
      ],
      features: [{ id: "f1", name: "base", type: "ExtrudeFeature", timelineIndex: 0, suppressed: false }],
      bodies: [body("b1", "Solid")],
      entities: [ROOT, REGISTERED("feature", "f1", "base"),
        { kind: "body" as const, id: "b1", name: "Solid", nativeToken: "t-b1" }],
    });
    const after = snapshot({
      parameters: [{ id: "p-user", name: "wall_thk", expression: "6 mm", valueMm: 6, unit: "mm" }],
      features: [],
      bodies: [],
      entities: [ROOT],
    });
    expect(fusionIntentPreservationViolations(before, after,
      [{ kind: "feature", id: "f1" }, { kind: "body", id: "b1" }])).toEqual([]);
    // The same removal without the auto-name exemption criteria still violates.
    const userParamGone = snapshot({ parameters: [], features: [], bodies: [], entities: [ROOT] });
    expect(fusionIntentPreservationViolations(before, userParamGone,
      [{ kind: "feature", id: "f1" }, { kind: "body", id: "b1" }])
      .some((message) => message.includes("wall_thk was removed"))).toBe(true);
  });

  it("flags damage to an unaffected existing feature", () => {
    const before = snapshot({
      features: [{ id: "f1", name: "base", type: "ExtrudeFeature", timelineIndex: 0, suppressed: false }],
      entities: [ROOT, REGISTERED("feature", "f1", "base")],
    });
    const after = snapshot({ features: [], entities: [ROOT] });
    const violations = fusionIntentPreservationViolations(before, after, []);
    expect(violations.some((message) => message.includes("was removed"))).toBe(true);
  });
});
