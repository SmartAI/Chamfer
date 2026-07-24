import { describe, expect, it } from "vitest";
import type { FusionMcpClient } from "./mcpClient";
import {
  captureFusionInspection,
  canonicalizeFusionSnapshot,
  evaluateFusionChecks,
  fingerprintFusionSnapshot,
} from "./inspection";
import { engineeringSnapshotScript } from "./inspectionScripts";
import { engineeringFingerprintCollector } from "./integrityScripts";
import { fingerprintFusionEngineering } from "./fingerprint";
import { fusionActionHarnessScript } from "./actionScripts";
import type { FusionActionRequestDto, FusionCheckInput } from "@chamfer/shared";
import { FUS_TEXT_002 } from "@chamfer/fusion-fixtures";

const rawSnapshot = {
  designIntent: { designType: "parametric", rootComponent: "Bracket", timelineMarker: 3 },
  units: { distance: "mm", angle: "deg", internalDistance: "cm" },
  parameters: [
    { id: "width", name: "width", expression: "80 mm", valueMm: 80, unit: "mm" },
    { id: "fillet", name: "corner_fillet", expression: "4 mm", valueMm: 4, unit: "mm" },
    { id: "angle", name: "groove_angle", expression: "40 deg", valueMm: 40, valueDegrees: 40, unit: "deg" },
  ],
  sketches: [{
    id: "sketch-1", name: "Base", plane: "XY", profiles: 1, curves: 4, constraints: ["horizontal"],
    geometry: [{ type: "SketchLine", data: { startPoint: [0, 0, 0], endPoint: [8, 0, 0] } }],
    constraintDetails: [{ type: "HorizontalConstraint", references: ["curve:0"] }],
    fullyConstrained: true,
  }],
  features: [
    { id: "feature-1", name: "Extrude", type: "ExtrudeFeature", timelineIndex: 0, suppressed: false },
    { id: "feature-2", name: "Centered Pocket", type: "ExtrudeFeature", timelineIndex: 1, suppressed: false },
    { id: "feature-3", name: "Vertical Corner Fillets", type: "FilletFeature", timelineIndex: 2, suppressed: false },
    { id: "feature-4", name: "Outer Perimeter Chamfers", type: "ChamferFeature", timelineIndex: 3, suppressed: false },
    { id: "feature-5", name: "Grip Groove Pattern", type: "CircularPatternFeature", timelineIndex: 4, suppressed: false },
  ],
  bodies: [{
    id: "body-1",
    name: "Body1",
    solid: true,
    volumeMm3: 24000,
    boundingBoxMm: [80, 30, 10],
    material: "Aluminum 6061",
    appearance: "Blue",
    appearanceColor: [30, 90, 180],
    geometrySignature: {
      faceCount: 6, edgeCount: 12, faceAreasMm2: [300, 300, 800, 800, 2400, 2400], edgeLengthsMm: [10, 30, 80],
      boundingBoxMinMm: [0, 0, 0], boundingBoxMaxMm: [80, 30, 10], centerOfMassMm: [40, 15, 5], bodyRevisionId: "body-rev-1",
    },
  }],
  materials: [{ id: "material-1", name: "Aluminum 6061", libraryName: "Fusion Material Library" }],
  holes: [[12, 12, 0], [68, 12, 0], [68, 18, 0], [12, 18, 0]].map((centerMm, index) => ({
    featureId: `hole-${index + 1}`, centerMm, diameterMm: 8.5, through: true, normal: [0, 0, 1],
  })),
  featureMeasurements: [
    { featureId: "feature-2", kind: "pocket", centerMm: [40, 15, 10], diameterMm: 40, depthMm: 4 },
    { featureId: "feature-3", kind: "fillet", radiusMm: 4, faceCount: 4, faceBoundsMm: [
      { min: [0, 0, 1.5], max: [4, 4, 8.5] }, { min: [76, 0, 1.5], max: [80, 4, 8.5] },
      { min: [76, 26, 1.5], max: [80, 30, 8.5] }, { min: [0, 26, 1.5], max: [4, 30, 8.5] },
    ] },
    { featureId: "feature-4", kind: "chamfer", distanceMm: 1.5, faceCount: 16, faceBoundsMm: Array.from({ length: 16 }, (_, index) => ({
      min: index % 2 === 0 ? [0, 4, index < 8 ? 0 : 8.5] : [4, 0, index < 8 ? 0 : 8.5],
      max: index % 2 === 0 ? [1.5, 26, index < 8 ? 1.5 : 10] : [76, 1.5, index < 8 ? 1.5 : 10],
    })) },
    { featureId: "feature-5", kind: "circular-pattern", occurrenceCount: 12 },
  ],
  entities: [{ kind: "body", id: "body-1", name: "Body1", nativeToken: "native-body-1", chamferId: "part-body" }],
};

describe("Fusion engineering inspection", () => {
  it("reads namespaced identity and semantic descriptors without writing user entities", () => {
    const source = engineeringSnapshotScript();
    expect(source).toContain('ATTR_GROUP = "com.chamfer.entity"');
    expect(source).toContain('ATTR_NAME = "uuid"');
    expect(source).toContain("semanticDescriptor");
    expect(source).toContain('parameter_id = identity["id"]');
    expect(source).toContain('sketch_id = identity["id"]');
    expect(source).toContain('feature_id = identity["id"]');
    expect(source).toContain('body_id = identity["id"]');
    expect(source).not.toMatch(/attributes\.add|\.add\(ATTR_GROUP/);
  });

  it("computes the token-free rollback fingerprint inside the snapshot execution", () => {
    // The shared collector must stay token-free: an entityToken read would push
    // a native Undo entry, and the standalone rollback loop runs the same code.
    expect(engineeringFingerprintCollector).not.toContain("entityToken");
    const source = engineeringSnapshotScript();
    expect(source).toContain("def _chamfer_engineering_fingerprint(design)");
    expect(source).toContain('"fingerprint": _chamfer_engineering_fingerprint(design)');
  });

  it("hashes the combined snapshot fingerprint identically to the standalone rollback helper", async () => {
    const fingerprintPayload = { designType: 1, defaultLengthUnits: "mm", parameters: [], sketches: [], extrudes: [], bodies: [{ name: "Body1", volume: 24, area: 62, faceCount: 6, edgeCount: 12 }] };
    const client = (payload: unknown): FusionMcpClient => ({
      connect: async () => { throw new Error("unused"); },
      close: async () => undefined,
      callJson: async () => ({ output: JSON.stringify(payload) }),
    });

    const captured = await captureFusionInspection(
      client({ document: { id: "doc-1", name: "Bracket", dataFileId: "data-1" }, snapshot: rawSnapshot, fingerprint: fingerprintPayload }),
      { id: "doc-1", name: "Bracket", dataFileId: "data-1" },
    );
    const standalone = await fingerprintFusionEngineering(client({ fingerprint: fingerprintPayload }), "doc-1");

    expect(captured.fingerprint).toBe(standalone);
    expect(captured.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keeps the inspection usable when the snapshot payload carries no fingerprint", async () => {
    const client: FusionMcpClient = {
      connect: async () => { throw new Error("unused"); },
      close: async () => undefined,
      callJson: async () => ({ output: JSON.stringify({ document: { id: "doc-1", name: "Bracket", dataFileId: "data-1" }, snapshot: rawSnapshot }) }),
    };

    const captured = await captureFusionInspection(client, { id: "doc-1", name: "Bracket", dataFileId: "data-1" });

    expect(captured.fingerprint).toBeUndefined();
    expect(captured.snapshot.bodies).toHaveLength(1);
  });

  it("supplies trusted entity registration and fails closed on ambiguous token resolution", () => {
    const request = {
      actionId: "action-1", document: { id: "doc", name: "Part" }, expectedEvidenceId: "evidence",
      expectedRevision: "rev", intent: "targeted revision", strategy: "targeted", body: "register_entity(root, 'component:Part')",
      affectedReferences: [{ id: "root-component", kind: "component" }],
      expectedEffects: [{ kind: "body-count", expected: 1 }], model: { provider: "openai", model: "gpt-5" },
      skills: { foundation: { name: "fusion-foundation", version: "1" }, loaded: [] },
    } satisfies FusionActionRequestDto;
    const source = fusionActionHarnessScript(request, request.document, { "root-component": "root-token" });
    expect(source).toContain("def register_entity(entity, semantic_descriptor)");
    expect(source).toContain('attributes.add("com.chamfer.entity", "uuid"');
    expect(source).toContain("if not resolved or len(resolved) != 1");
  });

  it("keeps revisions stable across order and UI-only state while detecting engineering changes", () => {
    const first = canonicalizeFusionSnapshot({
      ...rawSnapshot,
      camera: { eye: [1, 2, 3] },
      selection: ["face-1"],
      panels: { browser: false },
      temporaryVisibility: { "body-1": false },
    });
    const reordered = canonicalizeFusionSnapshot({
      ...rawSnapshot,
      parameters: [...rawSnapshot.parameters].reverse(),
      viewportStyle: "wireframe",
      camera: { eye: [9, 9, 9] },
      entities: rawSnapshot.entities.map((entity) => ({ ...entity, nativeToken: "reissued-token" })),
    });

    expect(fingerprintFusionSnapshot(first)).toBe(fingerprintFusionSnapshot(reordered));
    expect(fingerprintFusionSnapshot(canonicalizeFusionSnapshot({
      ...rawSnapshot,
      parameters: [{ ...rawSnapshot.parameters[0], valueMm: 90, expression: "90 mm" }],
    }))).not.toBe(fingerprintFusionSnapshot(first));
    expect(fingerprintFusionSnapshot(canonicalizeFusionSnapshot({
      ...rawSnapshot,
      bodies: rawSnapshot.bodies.map((body) => ({
        ...body,
        geometrySignature: {
          ...body.geometrySignature,
          boundingBoxMinMm: [10, 0, 0],
          boundingBoxMaxMm: [90, 30, 10],
          centerOfMassMm: [50, 15, 5],
          bodyRevisionId: "body-rev-2",
        },
      })),
    }))).not.toBe(fingerprintFusionSnapshot(first));
    expect(fingerprintFusionSnapshot(canonicalizeFusionSnapshot({
      ...rawSnapshot,
      sketches: rawSnapshot.sketches.map((sketch) => ({
        ...sketch,
        geometry: [{ type: "SketchLine", data: { startPoint: [0, 0, 0], endPoint: [9, 0, 0] } }],
      })),
    }))).not.toBe(fingerprintFusionSnapshot(first));
    expect(first).not.toHaveProperty("camera");
  });

  it("evaluates supported typed checks and reports unknown kinds explicitly", () => {
    const requested: FusionCheckInput[] = [
      { kind: "body-count", expected: 1 },
      { kind: "dimensions", expectedMm: [80, 30, 10], toleranceMm: 0.01 },
      { kind: "volume", minMm3: 23999, maxMm3: 24001 },
      { kind: "feature", featureType: "ExtrudeFeature", minCount: 1 },
      { kind: "material", expected: "Aluminum 6061" },
      { kind: "holes", expected: 4, diameterMm: 8.5, edgeOffsetMm: 12, through: true, toleranceMm: 0.02 },
      { kind: "hole-pattern", expected: 4, diameterMm: 8.5, through: true,
        centersMm: [[12, 12, 0], [68, 12, 0], [68, 18, 0], [12, 18, 0]], normal: [0, 0, 1], toleranceMm: 0.02 },
      { kind: "parameter", name: "corner_fillet", expectedMm: 4, toleranceMm: 0.01 },
      { kind: "angle-parameter", name: "groove_angle", expectedDegrees: 40, toleranceDegrees: 0.2 },
      { kind: "fully-constrained-sketches", minCount: 1, requireAll: true },
      { kind: "circular-pattern", name: "Grip Groove Pattern", expectedOccurrences: 12 },
      { kind: "pocket", name: "Centered Pocket", diameterMm: 40, depthMm: 4, centerMm: [40, 15], toleranceMm: 0.01 },
      { kind: "fillet", name: "Vertical Corner Fillets", radiusMm: 4, faceCount: 4, placement: "vertical-outer-corners", toleranceMm: 0.01 },
      { kind: "chamfer", name: "Outer Perimeter Chamfers", distanceMm: 1.5, faceCount: 16, placement: "top-bottom-outer-perimeter", toleranceMm: 0.01 },
      { kind: "appearance", targetRgb: [30, 90, 180], tolerance: 0 },
      { kind: "visual-evidence", requiredViews: ["front", "top", "isometric"] },
      { kind: "curvature-continuity", expected: "G2" },
      { kind: "volume" },
    ];
    const results = evaluateFusionChecks(canonicalizeFusionSnapshot(rawSnapshot), requested,
      { views: ["front", "top", "isometric"], cameraRestored: true });

    expect(results.map((result) => result.status)).toEqual([
      "passed", "passed", "passed", "passed", "passed", "passed", "passed", "passed", "passed", "passed", "passed", "passed", "passed", "passed", "passed", "passed", "unsupported", "failed",
    ]);
    expect(results[16]?.detail).toContain("curvature-continuity");
    // Every verdict echoes the exact check it evaluated: clients attribute
    // statuses by this echo, so it must be present even for unsupported kinds.
    expect(results.map((result) => result.input)).toEqual(requested);
  });

  it("fails native constraint, angle-expression, and pattern-occurrence mismatches", () => {
    const snapshot = canonicalizeFusionSnapshot(rawSnapshot);
    expect(evaluateFusionChecks(snapshot, [
      { kind: "angle-parameter", name: "groove_angle", expectedDegrees: 41, toleranceDegrees: 0.2 },
      { kind: "circular-pattern", name: "Grip Groove Pattern", expectedOccurrences: 11 },
    ]).map((result) => result.status)).toEqual(["failed", "failed"]);
    expect(evaluateFusionChecks(canonicalizeFusionSnapshot({
      ...rawSnapshot,
      sketches: rawSnapshot.sketches.map((sketch) => ({ ...sketch, fullyConstrained: false })),
    }), [{ kind: "fully-constrained-sketches", minCount: 1, requireAll: true }])[0]?.status).toBe("failed");
  });

  it("independently evaluates the industrial datum, machining, reinforcement, and thread contract", () => {
    const industrial = canonicalizeFusionSnapshot({
      ...rawSnapshot,
      parameters: FUS_TEXT_002.expectedEffects.filter((effect) => effect.kind === "parameter").map((effect) => ({
        id: `parameter:${effect.name}`, name: effect.name, expression: `${effect.expectedMm} mm`, valueMm: effect.expectedMm, unit: "mm",
      })),
      references: [
        { name: "Datum A - Base Bottom", originMm: [0, 0, 0], normal: [0, 0, 1] },
        { name: "Datum B - Wall Front", originMm: [0, -12, 0], normal: [0, 1, 0] },
        { name: "Datum C - Base Left", originMm: [-90, 0, 0], normal: [1, 0, 0] },
      ].map((reference, index) => ({ id: `datum:${index}`, ...reference, type: "plane" })),
      sketches: FUS_TEXT_002.expectedEffects.filter((effect) => effect.kind === "parametric-sketch").map((effect, index) => ({
        id: `industrial-sketch:${index}`, name: effect.name, plane: "parametric", profiles: 1, curves: 4, constraints: [], geometry: [], constraintDetails: [], dimensionExpressions: [...effect.requiredExpressions],
      })),
      features: [
        { id: "wall", name: "Upright Wall and Crown", type: "ExtrudeFeature", timelineIndex: 0, suppressed: false },
        { id: "seat", name: "Bearing Seat", type: "ExtrudeFeature", timelineIndex: 1, suppressed: false },
        { id: "recess", name: "Retaining Recess - Datum B Only", type: "ExtrudeFeature", timelineIndex: 2, suppressed: false },
        ...Array.from({ length: 4 }, (_, index) => ({ id: `gusset-${index}`, name: `Gusset ${index + 1}`, type: "ExtrudeFeature", timelineIndex: 3 + index, suppressed: false })),
        { id: "grease", name: "Grease Port M6x1", type: "HoleFeature", timelineIndex: 7, suppressed: false },
        { id: "base-fillets", name: "Base Corner Fillets", type: "FilletFeature", timelineIndex: 8, suppressed: false },
        { id: "fillets", name: "Structural Fillets", type: "FilletFeature", timelineIndex: 8, suppressed: false },
        { id: "gusset-fillets", name: "Gusset Root Fillets", type: "FilletFeature", timelineIndex: 8, suppressed: false },
        { id: "bearing-chamfers", name: "Bearing Mouth Chamfers", type: "ChamferFeature", timelineIndex: 9, suppressed: false },
        { id: "grease-chamfer", name: "Grease Port Entry Chamfer", type: "ChamferFeature", timelineIndex: 10, suppressed: false },
        { id: "base-chamfer", name: "Base Perimeter Chamfer", type: "ChamferFeature", timelineIndex: 11, suppressed: false },
      ],
      bodies: [{ ...rawSnapshot.bodies[0], boundingBoxMm: [180, 110, 131], material: "EN-GJS-500-7", appearanceColor: [65, 72, 78], geometrySignature: {
        ...rawSnapshot.bodies[0]!.geometrySignature, boundingBoxMinMm: [-90, -55, 0], boundingBoxMaxMm: [90, 55, 131],
      } }],
      materials: [{ id: "ductile-iron", name: "EN-GJS-500-7", libraryName: "Fusion Material Library" }],
      holes: [[-70, -35, 16], [70, -35, 16], [70, 35, 16], [-70, 35, 16]].map((centerMm, index) => ({
        featureId: `mount-${index}`, name: "Counterbored Mounting Holes", centerMm, diameterMm: 11, through: true,
        counterboreDiameterMm: 18, counterboreDepthMm: 8, direction: "negative",
      })),
      featureMeasurements: [
        { featureId: "wall", kind: "housing-profile", centerMm: [0, 0, 76], widthMm: 110, thicknessMm: 24, crownRadiusMm: 55 },
        { featureId: "seat", kind: "bore", centerMm: [0, 0, 76], diameterMm: 52.01, axis: "y", direction: "symmetric", depthMm: 24, through: true },
        { featureId: "recess", kind: "recess", centerMm: [0, -12, 76], diameterMm: 62, depthMm: 5, axis: "y", direction: "positive", datumName: "Datum B - Wall Front", through: false },
        ...[-45, 45].flatMap((x, xi) => [-12, 12].map((y, yi) => ({ featureId: `gusset-${xi * 2 + yi}`, kind: "gusset", centerMm: [x, y, 16], widthMm: 12, heightMm: 45, connectedBodyCount: 1 }))),
        { featureId: "grease", kind: "threaded-hole", centerMm: [0, 0, 131], diameterMm: 6, pitchMm: 1, axis: "z", direction: "negative", threadDesignation: "M6x1", intersectsFeature: "Bearing Seat" },
        { featureId: "base-fillets", kind: "fillet", radiusMm: 5, faceCount: 4, faceBoundsMm: [
          { min: [-90, -55, 0], max: [-85, -50, 16] }, { min: [85, -55, 0], max: [90, -50, 16] },
          { min: [85, 50, 0], max: [90, 55, 16] }, { min: [-90, 50, 0], max: [-85, 55, 16] },
        ] },
        { featureId: "fillets", kind: "fillet", radiusMm: 6, faceCount: 2, faceBoundsMm: [{ min: [-55, -18, 16], max: [55, -12, 22] }, { min: [-55, 12, 16], max: [55, 18, 22] }] },
        { featureId: "gusset-fillets", kind: "fillet", radiusMm: 6, faceCount: 4, faceBoundsMm: Array.from({ length: 4 }, (_, index) => ({ min: [index < 2 ? -51 : 39, index % 2 ? 12 : -18, 16], max: [index < 2 ? -39 : 51, index % 2 ? 18 : -12, 61] })) },
        { featureId: "bearing-chamfers", kind: "chamfer", distanceMm: 1, faceCount: 2, faceBoundsMm: [{ min: [-27, -12, 49], max: [27, -11, 103] }, { min: [-27, 11, 49], max: [27, 12, 103] }] },
        { featureId: "grease-chamfer", kind: "chamfer", distanceMm: 0.5, faceCount: 1, faceBoundsMm: [{ min: [-0.5, -0.5, 130.5], max: [0.5, 0.5, 131] }] },
        { featureId: "base-chamfer", kind: "chamfer", distanceMm: 2, faceCount: 4, faceBoundsMm: [{ min: [-90, -55, 14], max: [90, -53, 16] }, { min: [-90, 53, 14], max: [90, 55, 16] }, { min: [-90, -55, 14], max: [-88, 55, 16] }, { min: [88, -55, 14], max: [90, 55, 16] }] },
      ],
    });

    const results = evaluateFusionChecks(industrial, FUS_TEXT_002.expectedEffects, {
      views: ["front", "back", "left", "right", "top", "bottom", "isometric", "section"], cameraRestored: true,
    });
    expect(results.filter((result) => result.status !== "passed")).toEqual([]);

    const wrongDirection = canonicalizeFusionSnapshot({ ...industrial, featureMeasurements: industrial.featureMeasurements?.map((measurement) => measurement.kind === "recess" ? { ...measurement, direction: "symmetric" } : measurement) });
    expect(evaluateFusionChecks(wrongDirection, FUS_TEXT_002.expectedEffects).find((result) => result.kind === "directional-recess")?.status).toBe("failed");
  });

  it("rejects chamfers on vertical outer edges even when size and face count match", () => {
    const misplaced = canonicalizeFusionSnapshot({
      ...rawSnapshot,
      featureMeasurements: rawSnapshot.featureMeasurements.map((measurement) => measurement.kind === "chamfer" ? {
        ...measurement,
        faceBoundsMm: Array.from({ length: 16 }, () => ({ min: [0, 0, 0], max: [1.5, 30, 10] })),
      } : measurement),
    });
    expect(evaluateFusionChecks(misplaced, [{
      kind: "chamfer", name: "Outer Perimeter Chamfers", distanceMm: 1.5, faceCount: 16,
      placement: "top-bottom-outer-perimeter", toleranceMm: 0.01,
    }])[0]?.status).toBe("failed");
  });

  it("rejects a named native feature whose measured size differs from its feature contract", () => {
    expect(evaluateFusionChecks(canonicalizeFusionSnapshot(rawSnapshot), [{
      kind: "feature", featureType: "FilletFeature", name: "Vertical Corner Fillets",
      minCount: 1, maxCount: 1, expectedSizeMm: 6, toleranceMm: 0.01,
    }])[0]).toMatchObject({ status: "failed", detail: expect.stringContaining("measured sizes [4]") });
  });

  it("captures the standard native evidence order and restores the exact prior camera", async () => {
    const directions: string[] = [];
    const client: FusionMcpClient = {
      connect: async () => { throw new Error("unused"); },
      close: async () => undefined,
      callJson: async (tool, args) => {
        if (tool === "fusion_mcp_read") {
          directions.push(String(args.direction));
          return { data: Buffer.from(String(args.direction)).toString("base64"), mimeType: "image/png" };
        }
        const script = String((args.object as { script: string }).script);
        if (script.includes("CHAMFER_FUSION_ENGINEERING_SNAPSHOT_V1")) {
          return { output: JSON.stringify({ document: { id: "doc-1", name: "Bracket", dataFileId: "data-1" }, snapshot: rawSnapshot }) };
        }
        if (script.includes("CHAMFER_FUSION_INSPECTION_DOCUMENT_V1")) {
          return { output: JSON.stringify({ document: { id: "doc-1", name: "Bracket", dataFileId: "data-1" } }) };
        }
        if (script.includes("CHAMFER_FUSION_CAMERA_RESTORE_V1")) {
          return { output: JSON.stringify({ restored: true }) };
        }
        return { output: JSON.stringify({ camera: { eye: [1, 2, 3], target: [0, 0, 0], upVector: [0, 1, 0] } }) };
      },
    };

    const captured = await captureFusionInspection(client, { id: "doc-1", name: "Bracket", dataFileId: "data-1" }, true);

    expect(directions).toEqual(["front", "back", "left", "right", "top", "bottom", "iso-top-right"]);
    expect(captured.screenshots.map((shot) => shot.view)).toEqual([
      "front", "back", "left", "right", "top", "bottom", "isometric",
    ]);
    expect(captured.cameraRestored).toBe(true);
    expect(captured.screenshots[0]?.dataUrl).toMatch(/^data:image\/png;base64,/);
  });

  it("captures no views and never moves the camera by default (no visual-evidence request)", async () => {
    let screenshotReads = 0;
    let cameraScriptRan = false;
    const client: FusionMcpClient = {
      connect: async () => { throw new Error("unused"); },
      close: async () => undefined,
      callJson: async (tool, args) => {
        if (tool === "fusion_mcp_read") { screenshotReads += 1; return { data: "cG5n", mimeType: "image/png" }; }
        const script = String((args.object as { script: string }).script);
        if (script.includes("CHAMFER_FUSION_ENGINEERING_SNAPSHOT_V1")) {
          return { output: JSON.stringify({ document: { id: "doc-1", name: "Bracket", dataFileId: "data-1" }, snapshot: rawSnapshot }) };
        }
        if (script.includes("CHAMFER_FUSION_CAMERA")) cameraScriptRan = true;
        return { output: JSON.stringify({ camera: { eye: [1, 2, 3] } }) };
      },
    };

    // Default capture is scalar-only: the flicker-causing camera sweep never runs,
    // and the camera is trivially reported restored because it never moved.
    const captured = await captureFusionInspection(client, { id: "doc-1", name: "Bracket", dataFileId: "data-1" });

    expect(captured.screenshots).toEqual([]);
    expect(captured.cameraRestored).toBe(true);
    expect(screenshotReads).toBe(0);
    expect(cameraScriptRan).toBe(false);
  });

  it("reports failed exact camera restoration without hiding captured engineering state", async () => {
    let cameraReads = 0;
    const client: FusionMcpClient = {
      connect: async () => { throw new Error("unused"); },
      close: async () => undefined,
      callJson: async (tool, args) => {
        if (tool === "fusion_mcp_read") return [{ type: "image", base64Data: "cG5n", mimeType: "image/png" }];
        const script = String((args.object as { script: string }).script);
        if (script.includes("CHAMFER_FUSION_ENGINEERING_SNAPSHOT_V1")) {
          return { output: JSON.stringify({ document: { id: "doc-1", name: "Bracket", dataFileId: "data-1" }, snapshot: rawSnapshot }) };
        }
        if (script.includes("CHAMFER_FUSION_CAMERA_RESTORE_V1")) {
          return { output: JSON.stringify({ restored: true }) };
        }
        cameraReads += 1;
        return { output: JSON.stringify({ camera: { eye: cameraReads === 1 ? [1, 2, 3] : [9, 9, 9] } }) };
      },
    };

    const captured = await captureFusionInspection(client, undefined, true);

    expect(captured.cameraRestored).toBe(false);
    expect(captured.snapshot.bodies).toHaveLength(1);
  });

  it("rejects evidence when engineering state changes while screenshots are captured", async () => {
    let engineeringReads = 0;
    const client: FusionMcpClient = {
      connect: async () => { throw new Error("unused"); },
      close: async () => undefined,
      callJson: async (tool, args) => {
        if (tool === "fusion_mcp_read") return { data: "cG5n", mimeType: "image/png" };
        const script = String((args.object as { script: string }).script);
        if (script.includes("CHAMFER_FUSION_ENGINEERING_SNAPSHOT_V1")) {
          engineeringReads += 1;
          // Vary a genuinely fingerprinted engineering field (a driving parameter
          // value) to simulate a mid-capture change. designIntent.rootComponent
          // and timelineMarker are deliberately excluded from the fingerprint
          // because Fusion re-derives them without a geometry difference.
          return { output: JSON.stringify({ snapshot: {
            ...rawSnapshot,
            parameters: rawSnapshot.parameters.map((parameter, index) => index === 0
              ? { ...parameter, valueMm: engineeringReads === 1 ? 80 : 81, expression: engineeringReads === 1 ? "80 mm" : "81 mm" }
              : parameter),
          } }) };
        }
        if (script.includes("CHAMFER_FUSION_CAMERA_RESTORE_V1")) return { output: JSON.stringify({ restored: true }) };
        return { output: JSON.stringify({ camera: { eye: [1, 2, 3] } }) };
      },
    };

    await expect(captureFusionInspection(client, undefined, true)).rejects.toMatchObject({
      message: "Fusion engineering revision changed during evidence capture",
      cameraRestored: true,
    });
  });

  it("degrades evidence when Fusion rejects the camera restoration operation", async () => {
    const client: FusionMcpClient = {
      connect: async () => { throw new Error("unused"); },
      close: async () => undefined,
      callJson: async (tool, args) => {
        if (tool === "fusion_mcp_read") return { data: "cG5n", mimeType: "image/png" };
        const script = String((args.object as { script: string }).script);
        if (script.includes("CHAMFER_FUSION_ENGINEERING_SNAPSHOT_V1")) {
          return { output: JSON.stringify({ snapshot: rawSnapshot }) };
        }
        if (script.includes("CHAMFER_FUSION_CAMERA_RESTORE_V1")) throw new Error("restore rejected");
        return { output: JSON.stringify({ camera: { eye: [1, 2, 3] } }) };
      },
    };

    const captured = await captureFusionInspection(client, undefined, true);

    expect(captured.cameraRestored).toBe(false);
    expect(captured.screenshots).toHaveLength(7);
  });

  it("rejects evidence captured after Fusion switches away from the bound document", async () => {
    const client: FusionMcpClient = {
      connect: async () => { throw new Error("unused"); },
      close: async () => undefined,
      callJson: async (_tool, args) => {
        const script = String((args.object as { script: string }).script);
        if (script.includes("CHAMFER_FUSION_ENGINEERING_SNAPSHOT_V1")) {
          return { output: JSON.stringify({
            document: { id: "doc-2", name: "Other", dataFileId: "data-2" },
            snapshot: rawSnapshot,
          }) };
        }
        return { output: JSON.stringify({ camera: {} }) };
      },
    };

    await expect(captureFusionInspection(client, { id: "doc-1", name: "Bracket", dataFileId: "data-1" }))
      .rejects.toThrow("bound Fusion document");
  });

  it("rejects screenshots if the active document changes during capture and guards camera restoration", async () => {
    let identityReads = 0;
    let screenshotReads = 0;
    let restoreSource = "";
    const client: FusionMcpClient = {
      connect: async () => { throw new Error("unused"); },
      close: async () => undefined,
      callJson: async (tool, args) => {
        if (tool === "fusion_mcp_read") {
          screenshotReads += 1;
          return { type: "image", base64Data: "cG5n", mimeType: "image/png" };
        }
        const script = String((args.object as { script: string }).script);
        if (script.includes("CHAMFER_FUSION_ENGINEERING_SNAPSHOT_V1")) {
          return { output: JSON.stringify({ document: { id: "doc-1", name: "Bracket", dataFileId: "data-1" }, snapshot: rawSnapshot }) };
        }
        if (script.includes("CHAMFER_FUSION_INSPECTION_DOCUMENT_V1")) {
          identityReads += 1;
          const switched = identityReads > 1;
          return { output: JSON.stringify({ document: switched
            ? { id: "doc-2", name: "Other", dataFileId: "data-2" }
            : { id: "doc-1", name: "Bracket", dataFileId: "data-1" } }) };
        }
        if (script.includes("CHAMFER_FUSION_CAMERA_RESTORE_V1")) {
          restoreSource = script;
          return { output: JSON.stringify({ restored: false }) };
        }
        return { output: JSON.stringify({ camera: { eye: [1, 2, 3] } }) };
      },
    };

    await expect(captureFusionInspection(client, { id: "doc-1", name: "Bracket", dataFileId: "data-1" }, true))
      .rejects.toThrow("bound Fusion document");
    expect(screenshotReads).toBe(1);
    expect(restoreSource).toContain("expected_document");
  });
});
