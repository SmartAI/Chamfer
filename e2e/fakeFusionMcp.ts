import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { FUS_IMAGE_001_ACTION_BODY, FUS_TEXT_001_ACTION_BODY, FUS_TEXT_002, FUS_TEXT_002_ACTION_BODY } from "@chamfer/fusion-fixtures";

type Scenario = "unavailable" | "incompatible" | "no-document" | "wrong-document" | "provisional" | "provisional-lost" | "read-only" | "busy" | "unsupported" | "degraded" | "ready";
const port = Number(process.env.FUSION_FAKE_PORT ?? "8997");
let scenario: Scenario = "ready";
let camera = { eye: [1, 2, 3], target: [0, 0, 0], upVector: [0, 1, 0], cameraType: 0, perspectiveAngle: 0.5, viewExtents: 10, isFitView: false };
let documentationReads = 0;
let mutationCalls = 0;
let unmatchedScripts: string[] = [];
let nativeUndoEntries = 0;
let model: "empty" | "cube" | "plate" | "bearing-housing" | "bracket" = "empty";
type FixtureVariant = "passing" | "direct" | "omitted-feature" | "wrong-material" | "wrong-appearance" | "displaced-camera" | "wrong-dimensions" | "extra-history" | "wrong-document" | "unsupported-verification"
  | "broken-datums" | "mirrored-recess" | "reversed-counterbores" | "disconnected-gusset" | "false-thread" | "wrong-seat-fit"
  | "wrong-feature-size" | "reversed-upright" | "wrong-face-holes" | "swapped-diameters";
let fixtureVariant: FixtureVariant = "passing";
let wrongDocumentActive = false;
let cubeWidth = 20;
// Real Fusion Undo walks back through history; a fake undo that always jumps to
// a fixed state can never satisfy the server's verified-rollback loop when the
// pre-action state was anything else. Keep a stack of engineering states so
// undo restores exactly what the preceding mutation replaced.
let undoStack: Array<{ model: typeof model; cubeWidth: number }> = [];
const IDS = {
  parameter: "11111111-1111-4111-8111-111111111111",
  sketch: "22222222-2222-4222-8222-222222222222",
  feature: "33333333-3333-4333-8333-333333333333",
  body: "44444444-4444-4444-8444-444444444444",
};
let provisionalSaved = false;
let saveOutcome: "success" | "canceled" | "failed" = "success";
let saveCalls = 0;
const ACTION_OUTCOMES = ["success", "delayed", "delayed-inspection", "timeout", "disconnect", "unrelated-document-disconnect",
  "uncertain-disconnect", "verification-failure", "undo-failure"] as const;
type ActionOutcome = (typeof ACTION_OUTCOMES)[number];
function isActionOutcome(value: string): value is ActionOutcome {
  return (ACTION_OUTCOMES as readonly string[]).includes(value);
}
let actionOutcome: ActionOutcome = "success";
let delayPostInspection = false;
let postInspectionStarted = false;

const property = (type: string, values?: string[]) => values ? { type, enum: values } : { type };
const tools = [
  { name: "fusion_mcp_execute", inputSchema: { type: "object", required: ["featureType", "object"], properties: { featureType: property("string", ["script", "document"]), object: { type: "object", properties: { operation: property("string", ["open", "close", "save"]), script: property("string") } } } } },
  { name: "fusion_mcp_read", inputSchema: { type: "object", required: ["queryType"], properties: { queryType: property("string", ["apiDocumentation", "screenshot", "document", "projects", "activeCommand"]), direction: property("string", ["current", "front", "back", "top", "iso-top-right"]) } } },
  { name: "fusion_mcp_update", inputSchema: { type: "object", required: ["featureType"], properties: { featureType: property("string", ["undo", "redo"]) } } },
  { name: "fusion_mcp_electronics_read", inputSchema: { type: "object", required: ["entity_type"], properties: { entity_type: property("string", ["electronics.Board"]) } } },
];

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

function toolError(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

function inspection() {
  if (scenario === "no-document") return { document: null, inspectorHealthy: true };
  const document = scenario === "wrong-document" || scenario === "provisional-lost" || wrongDocumentActive
    ? { id: "fake-document-2", name: "Other Fixture", dataFileId: "fake-data-file-2" }
    : scenario === "provisional"
      ? provisionalSaved
        ? { id: "fake-unsaved-document", name: "Saved Fixture", dataFileId: "fake-saved-data-file", versionId: "fake-version-1", versionNumber: 1 }
        : { id: "fake-unsaved-document", name: "Unsaved Fixture" }
      : { id: "fake-document-1", name: "Readiness Fixture", dataFileId: "fake-data-file-1" };
  return {
    document,
    openDocumentIds: scenario === "wrong-document"
      ? ["fake-document-1", "fake-document-2"]
      : [document.id],
    writable: scenario !== "read-only",
    isModified: scenario === "provisional" ? !provisionalSaved : model !== "empty",
    busy: scenario === "busy",
    supported: scenario !== "unsupported",
    inspectorHealthy: scenario !== "degraded",
    fusionVersion: "2704.1.23",
  };
}

function engineeringSnapshot() {
  if (model === "bearing-housing") return industrialEngineeringSnapshot();
  const hasSolid = model !== "empty";
  if (model === "bracket") {
    const entityUuid = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    const reversed = fixtureVariant === "reversed-upright";
    const wrongFace = fixtureVariant === "wrong-face-holes";
    const swapped = fixtureVariant === "swapped-diameters";
    const wrongDimensions = fixtureVariant === "wrong-dimensions";
    const parameters = [
      ["base_width", wrongDimensions ? 99 : 100], ["base_depth", 60], ["base_thickness", 8], ["upright_width", 100],
      ["upright_height_above_base", 60], ["upright_thickness", 8], ["base_hole_diameter", 7],
      ["base_hole_x_1", 20], ["base_hole_x_2", 80], ["base_hole_y", 20], ["upright_hole_diameter", 10],
      ["upright_hole_x_1", 25], ["upright_hole_x_2", 75], ["upright_hole_height", 35],
      ["inside_fillet_radius", 6], ["outside_chamfer_distance", 1.5],
    ].map(([name, value]) => ({ id: `parameter:${name}`, name, expression: `${value} mm`, valueMm: value, unit: "mm" }));
    const features = [
      { name: "Base Extrude", type: "ExtrudeFeature" }, { name: "Upright Extrude", type: "ExtrudeFeature" },
      ...Array.from({ length: 2 }, (_, index) => ({ name: `Base Through Hole ${index + 1}`, type: "HoleFeature" })),
      ...Array.from({ length: 2 }, (_, index) => ({ name: `Upright Through Hole ${index + 1}`, type: "HoleFeature" })),
      { name: "Inside Junction Fillet", type: "FilletFeature" },
      ...(fixtureVariant === "omitted-feature" ? [] : [{ name: "Exposed Outside Chamfers", type: "ChamferFeature" }]),
      ...(fixtureVariant === "extra-history" ? [{ name: "Unrelated Rebuild", type: "ExtrudeFeature" }] : []),
    ].map((feature, index) => ({ id: `feature:${index}`, ...feature, timelineIndex: index, suppressed: false }));
    const baseY = 20;
    const uprightY = reversed ? 8 : 52;
    return { document: inspection().document, snapshot: {
      designIntent: { designType: fixtureVariant === "direct" ? "direct" : "parametric", rootComponent: "Readiness Fixture", timelineMarker: features.length },
      units: { distance: "mm", angle: "deg", internalDistance: "cm" }, parameters,
      sketches: [{ id: "sketch:base", name: "Base Sketch", plane: "XY", profiles: 1, curves: 4, constraints: [], geometry: [], constraintDetails: [] },
        { id: "sketch:upright", name: "Upright Sketch", plane: "XZ@52", profiles: 1, curves: 4, constraints: [], geometry: [], constraintDetails: [] },
        ...Array.from({ length: 2 }, (_, index) => ({ id: `sketch:base-hole-${index + 1}`, name: `Base Hole ${index + 1} Position`, plane: "XY@8", profiles: 0, curves: 0, constraints: [], geometry: [], constraintDetails: [] })),
        ...Array.from({ length: 2 }, (_, index) => ({ id: `sketch:upright-hole-${index + 1}`, name: `Upright Hole ${index + 1} Position`, plane: "XZ@52", profiles: 0, curves: 0, constraints: [], geometry: [], constraintDetails: [] }))],
      features,
      bodies: [{ id: "body:0", name: "FUS-IMAGE-001 Orange ABS Bracket", solid: true, volumeMm3: 88000,
        boundingBoxMm: [wrongDimensions ? 99 : 100, 60, 68], material: fixtureVariant === "wrong-material" ? "Steel" : "ABS Plastic",
        appearance: "Orange plastic", appearanceColor: fixtureVariant === "wrong-appearance" ? [30, 90, 180] : [240, 100, 20],
        geometrySignature: { faceCount: 30, edgeCount: 60, faceAreasMm2: [], edgeLengthsMm: [], boundingBoxMinMm: [0, 0, 0],
          boundingBoxMaxMm: [wrongDimensions ? 99 : 100, 60, 68], centerOfMassMm: [50, 42, 22], bodyRevisionId: "fake-bracket-v1" } }],
      materials: [{ id: "material", name: fixtureVariant === "wrong-material" ? "Steel" : "ABS Plastic" }],
      holes: [
        { featureId: "feature:2", centerMm: [20, baseY, 8], diameterMm: swapped ? 10 : 7, through: true, normal: wrongFace ? [0, 1, 0] : [0, 0, 1] },
        { featureId: "feature:3", centerMm: [80, baseY, 8], diameterMm: swapped ? 10 : 7, through: true, normal: wrongFace ? [0, 1, 0] : [0, 0, 1] },
        { featureId: "feature:4", centerMm: [25, uprightY, 43], diameterMm: swapped ? 7 : 10, through: true, normal: wrongFace ? [0, 0, 1] : [0, 1, 0] },
        { featureId: "feature:5", centerMm: [75, uprightY, 43], diameterMm: swapped ? 7 : 10, through: true, normal: wrongFace ? [0, 0, 1] : [0, 1, 0] },
      ], featureMeasurements: [
        { featureId: "feature:6", kind: "fillet", radiusMm: fixtureVariant === "wrong-feature-size" ? 5 : 6, faceCount: 1, faceBoundsMm: [] },
        ...(fixtureVariant === "omitted-feature" ? [] : [{ featureId: "feature:7", kind: "chamfer", distanceMm: fixtureVariant === "wrong-feature-size" ? 2 : 1.5, faceCount: 1, faceBoundsMm: [] }]),
      ], entities: [
        { kind: "component", id: "root-component", name: "Readiness Fixture", nativeToken: "fake-root-token", semanticDescriptor: "component:Readiness Fixture" },
        ...parameters.map((parameter, index) => ({ kind: "parameter", id: parameter.id, name: parameter.name, nativeToken: `token:${parameter.id}`,
          chamferId: entityUuid(index + 1), semanticDescriptor: `parameter:${parameter.name}` })),
        { kind: "sketch", id: "sketch:base", name: "Base Sketch", nativeToken: "token:sketch:base", chamferId: entityUuid(20), semanticDescriptor: "sketch:Base Sketch@XY" },
        { kind: "sketch", id: "sketch:upright", name: "Upright Sketch", nativeToken: "token:sketch:upright", chamferId: entityUuid(21), semanticDescriptor: "sketch:Upright Sketch@XZ" },
        ...Array.from({ length: 4 }, (_, index) => ({ kind: "sketch", id: `sketch:position:${index}`, name: `Hole Position ${index + 1}`,
          nativeToken: `token:sketch:position:${index}`, chamferId: entityUuid(22 + index), semanticDescriptor: `sketch:Hole Position ${index + 1}` })),
        ...features.map((feature, index) => ({ kind: "feature", id: feature.id, name: feature.name, nativeToken: `token:${feature.id}`,
          chamferId: entityUuid(30 + index), semanticDescriptor: `feature:${feature.type}:${feature.name}` })),
        { kind: "body", id: "body:0", name: "FUS-IMAGE-001 Orange ABS Bracket", nativeToken: "token:body:0", chamferId: entityUuid(50), semanticDescriptor: "body:FUS-IMAGE-001 Orange ABS Bracket" },
      ],
    } };
  }
  const plate = model === "plate";
  return {
    document: inspection().document,
    snapshot: {
      designIntent: { designType: plate && fixtureVariant === "direct" ? "direct" : "parametric", rootComponent: "Readiness Fixture", timelineMarker: plate ? 8 : hasSolid ? 2 : 0 },
      units: { distance: "mm", angle: "deg", internalDistance: "cm" },
      parameters: plate ? [
        ["plate_length", 120], ["plate_width", 80], ["plate_thickness", 12], ["hole_diameter", 8.5],
        ["hole_edge_offset", 12], ["pocket_diameter", 40], ["pocket_depth", 4], ["corner_fillet", 4], ["perimeter_chamfer", 1.5],
      ].map(([name, value]) => ({ id: `parameter:${name}`, name, expression: `${name === "plate_length" && fixtureVariant === "wrong-dimensions" ? 119 : value} mm`, valueMm: name === "plate_length" && fixtureVariant === "wrong-dimensions" ? 119 : value, unit: "mm" }))
        : hasSolid ? [{ id: `chamfer:${IDS.parameter}`, name: "width", expression: `${cubeWidth} mm`, valueMm: cubeWidth, unit: "mm" }] : [],
      sketches: plate
        ? [{ id: "sketch:0", name: "Base sketch", plane: "XY", profiles: 1, curves: 4, constraints: [], geometry: [], constraintDetails: [] }]
        : hasSolid ? [{ id: `chamfer:${IDS.sketch}`, name: "Base sketch", plane: "XY", profiles: 1, curves: 4, constraints: ["HorizontalConstraint"], geometry: [], constraintDetails: [] }] : [],
      features: plate ? [
        { name: "Plate Base", type: "ExtrudeFeature" },
        ...Array.from({ length: 4 }, (_, index) => ({ name: `Through Hole ${index + 1}`, type: "HoleFeature" })),
        { name: "Centered Pocket", type: "ExtrudeFeature" },
        { name: "Vertical Corner Fillets", type: "FilletFeature" },
        { name: "Outer Perimeter Chamfers", type: "ChamferFeature" },
        ...(fixtureVariant === "extra-history" ? [{ name: "Unrelated Rebuild", type: "ExtrudeFeature" }] : []),
      ].map((feature, index) => ({ id: `feature:${index}`, ...feature, timelineIndex: index, suppressed: false }))
        : hasSolid ? [{ id: `chamfer:${IDS.feature}`, name: "Cube extrusion", type: "ExtrudeFeature", timelineIndex: 0, suppressed: false }] : [],
      bodies: hasSolid ? [plate ? { id: "body:0", name: "FUS-TEXT-001 Mounting Plate", solid: true,
        volumeMm3: 102000, boundingBoxMm: [fixtureVariant === "wrong-dimensions" ? 119 : 120, 80, 12],
        material: fixtureVariant === "wrong-material" ? "Steel" : "Aluminum 6061", appearance: "Blue anodized", appearanceColor: fixtureVariant === "wrong-appearance" ? [180, 90, 30] : [30, 90, 180],
        geometrySignature: { faceCount: 24, edgeCount: 48, faceAreasMm2: [], edgeLengthsMm: [],
          boundingBoxMinMm: [fixtureVariant === "wrong-dimensions" ? -59.5 : -60, -40, 0], boundingBoxMaxMm: [fixtureVariant === "wrong-dimensions" ? 59.5 : 60, 40, 12],
          centerOfMassMm: [0, 0, 6], bodyRevisionId: "fake-plate-v1" } }
        : { id: `chamfer:${IDS.body}`, name: "Cube", solid: true, volumeMm3: cubeWidth * 400, boundingBoxMm: [cubeWidth, 20, 20], material: "Aluminum 6061", appearance: "Blue anodized",
          geometrySignature: { faceCount: 6, edgeCount: 12, faceAreasMm2: [400, 400, cubeWidth * 20, cubeWidth * 20, cubeWidth * 20, cubeWidth * 20], edgeLengthsMm: [cubeWidth, cubeWidth, cubeWidth, cubeWidth, ...Array(8).fill(20)], boundingBoxMinMm: [0, 0, 0], boundingBoxMaxMm: [cubeWidth, 20, 20], centerOfMassMm: [cubeWidth / 2, 10, 10], bodyRevisionId: `fake-cube-${cubeWidth}` } }] : [],
      materials: plate ? [{ id: "material", name: fixtureVariant === "wrong-material" ? "Steel" : "Aluminum 6061" }]
        : hasSolid ? [{ id: "al-6061", name: "Aluminum 6061" }] : [],
      holes: plate ? [[-48, -28, 0], [48, -28, 0], [48, 28, 0], [-48, 28, 0]].map((centerMm, index) => ({
        featureId: `feature:${index + 1}`, centerMm, diameterMm: 8.5, through: true,
      })) : [],
      featureMeasurements: plate ? [
        { featureId: "feature:5", kind: "pocket", centerMm: [0, 0, 12], diameterMm: 40, depthMm: 4 },
        { featureId: "feature:6", kind: "fillet", radiusMm: 4, faceCount: 4, faceBoundsMm: [
          { min: [-60, -40, 1.5], max: [-56, -36, 10.5] }, { min: [56, -40, 1.5], max: [60, -36, 10.5] },
          { min: [56, 36, 1.5], max: [60, 40, 10.5] }, { min: [-60, 36, 1.5], max: [-56, 40, 10.5] },
        ] },
        ...(fixtureVariant === "omitted-feature" ? [] : [{ featureId: "feature:7", kind: "chamfer", distanceMm: 1.5, faceCount: 16,
          faceBoundsMm: Array.from({ length: 16 }, (_, index) => ({
            min: index % 2 === 0 ? [-60, -36, index < 8 ? 0 : 10.5] : [-56, -40, index < 8 ? 0 : 10.5],
            max: index % 2 === 0 ? [-58.5, 36, index < 8 ? 1.5 : 12] : [56, -38.5, index < 8 ? 1.5 : 12],
          })),
        }]),
      ] : [],
      entities: [
        { kind: "component", id: "root-component", name: "Readiness Fixture", nativeToken: "fake-root-token", semanticDescriptor: "component:Readiness Fixture" },
        ...(hasSolid && !plate ? [
          { kind: "parameter", id: `chamfer:${IDS.parameter}`, chamferId: IDS.parameter, name: "width", nativeToken: `width-${cubeWidth}`, semanticDescriptor: "parameter:width" },
          { kind: "sketch", id: `chamfer:${IDS.sketch}`, chamferId: IDS.sketch, name: "Base sketch", nativeToken: `sketch-${cubeWidth}`, semanticDescriptor: "sketch:Base sketch@XY" },
          { kind: "feature", id: `chamfer:${IDS.feature}`, chamferId: IDS.feature, name: "Cube extrusion", nativeToken: `feature-${cubeWidth}`, semanticDescriptor: "feature:ExtrudeFeature:Cube extrusion" },
          { kind: "body", id: `chamfer:${IDS.body}`, chamferId: IDS.body, name: "Cube", nativeToken: `body-${cubeWidth}`, semanticDescriptor: "body:Cube" },
        ] : []),
      ],
    },
  };
}

function industrialEngineeringSnapshot() {
  const parameterValues: Array<[string, number]> = [
    ["base_width", 180], ["base_depth", 110], ["base_thickness", 16], ["wall_width", 110], ["wall_thickness", 24],
    ["bearing_axis_height", 76], ["crown_radius", 55], ["bearing_seat_nominal", 52], ["retaining_recess_diameter", 62],
    ["retaining_recess_depth", 5], ["mount_hole_diameter", 11], ["counterbore_diameter", 18], ["counterbore_depth", 8],
    ["gusset_width", 12], ["gusset_height", 45], ["grease_port_diameter", 6], ["grease_port_pitch", 1],
    ["mount_x_offset", 70], ["mount_y_offset", 35], ["gusset_x_offset", 45], ["gusset_foot_offset", 45],
    ["structural_fillet", 6], ["base_corner_fillet", 5], ["bearing_chamfer", 1], ["grease_chamfer", 0.5], ["base_chamfer", 2],
  ];
  const features = [
    ["One Solid Base", "ExtrudeFeature"], ["Upright Wall and Crown", "ExtrudeFeature"], ["Bearing Seat", "ExtrudeFeature"],
    ["Retaining Recess - Datum B Only", "ExtrudeFeature"], ["Counterbored Mounting Holes", "HoleFeature"],
    ...Array.from({ length: 4 }, (_, index) => [`Gusset ${index + 1}`, "ExtrudeFeature"]),
    ["Grease Port M6x1", "HoleFeature"], ["Grease Port M6x1 Native Thread", "ThreadFeature"],
    ["Base Corner Fillets", "FilletFeature"], ["Structural Fillets", "FilletFeature"], ["Gusset Root Fillets", "FilletFeature"], ["Bearing Mouth Chamfers", "ChamferFeature"],
    ["Grease Port Entry Chamfer", "ChamferFeature"], ["Base Perimeter Chamfer", "ChamferFeature"],
  ].map(([name, type], index) => ({ id: `industrial-feature:${index}`, name, type, timelineIndex: index, suppressed: false }));
  const featureId = (name: string) => features.find((feature) => feature.name === name)!.id;
  const mountingCenters = [[-70, -35, 16], [70, -35, 16], [70, 35, 16], [-70, 35, 16]];
  const gussetCenters = [[-45, -12, 16], [-45, 12, 16], [45, -12, 16], [45, 12, 16]];
  return {
    document: inspection().document,
    snapshot: {
      designIntent: { designType: "parametric", rootComponent: "Readiness Fixture", timelineMarker: features.length },
      units: { distance: "mm", angle: "deg", internalDistance: "cm" },
      parameters: parameterValues.map(([name, value]) => ({ id: `parameter:${name}`, name, expression: `${value} mm`, valueMm: value, unit: "mm" })),
      references: [
        { name: "Datum A - Base Bottom", originMm: [0, 0, 0], normal: [0, 0, 1] },
        { name: "Datum B - Wall Front", originMm: [0, -12, 0], normal: [0, 1, 0] },
        ...(fixtureVariant === "broken-datums" ? [] : [{ name: "Datum C - Base Left", originMm: [-90, 0, 0], normal: [1, 0, 0] }]),
      ].map((reference, index) => ({ id: `datum:${index}`, ...reference, type: "plane" })),
      sketches: FUS_TEXT_002.expectedEffects.filter((effect) => effect.kind === "parametric-sketch").map((effect, index) => ({
        id: `industrial-sketch:${index}`, name: effect.name, plane: "parametric", profiles: 1, curves: 4, constraints: [], geometry: [], constraintDetails: [], dimensionExpressions: [...effect.requiredExpressions],
      })), features,
      bodies: [{ id: "industrial-body", name: "FUS-TEXT-002 Industrial Bearing Housing", solid: true, volumeMm3: 510000,
        boundingBoxMm: [180, 110, 131], material: "EN-GJS-500-7", appearance: "Machine Gray", appearanceColor: [65, 72, 78],
        geometrySignature: { faceCount: 72, edgeCount: 144, faceAreasMm2: [], edgeLengthsMm: [], boundingBoxMinMm: [-90, -55, 0], boundingBoxMaxMm: [90, 55, 131], centerOfMassMm: [0, 0, 38], bodyRevisionId: "fake-industrial-v1" } }],
      materials: [{ id: "ductile-iron", name: "EN-GJS-500-7", libraryName: "Fusion Material Library" }],
      holes: mountingCenters.map((centerMm, index) => ({ featureId: `${featureId("Counterbored Mounting Holes")}:${index}`, name: "Counterbored Mounting Holes", centerMm,
        diameterMm: 11, through: true, counterboreDiameterMm: 18, counterboreDepthMm: 8, direction: fixtureVariant === "reversed-counterbores" ? "positive" : "negative" })),
      featureMeasurements: [
        { featureId: featureId("Upright Wall and Crown"), kind: "housing-profile", centerMm: [0, 0, 76], widthMm: 110, thicknessMm: 24, crownRadiusMm: 55 },
        { featureId: featureId("Bearing Seat"), kind: "bore", centerMm: [0, 0, 76], diameterMm: fixtureVariant === "wrong-seat-fit" ? 52.05 : 52.01, depthMm: 24, axis: "y", direction: "symmetric", through: true },
        { featureId: featureId("Retaining Recess - Datum B Only"), kind: "recess", centerMm: [0, -12, 76], diameterMm: 62, depthMm: 5, axis: "y",
          direction: fixtureVariant === "mirrored-recess" ? "symmetric" : "positive", through: fixtureVariant === "mirrored-recess", datumName: "Datum B - Wall Front" },
        ...gussetCenters.map((centerMm, index) => ({ featureId: featureId(`Gusset ${index + 1}`), kind: "gusset", centerMm, widthMm: 12, heightMm: 45,
          connectedBodyCount: fixtureVariant === "disconnected-gusset" && index === 0 ? 2 : 1 })),
        { featureId: featureId("Grease Port M6x1"), kind: "threaded-hole", centerMm: [0, 0, 131], diameterMm: 6, pitchMm: 1, axis: "z", direction: "negative",
          threadDesignation: fixtureVariant === "false-thread" ? undefined : "M6x1", intersectsFeature: "Bearing Seat" },
        { featureId: featureId("Base Corner Fillets"), kind: "fillet", radiusMm: 5, faceCount: 4, faceBoundsMm: [
          { min: [-90, -55, 0], max: [-85, -50, 16] }, { min: [85, -55, 0], max: [90, -50, 16] },
          { min: [85, 50, 0], max: [90, 55, 16] }, { min: [-90, 50, 0], max: [-85, 55, 16] },
        ] },
        { featureId: featureId("Structural Fillets"), kind: "fillet", radiusMm: 6, faceCount: 2, faceBoundsMm: [
          { min: [-55, -18, 16], max: [55, -12, 22] }, { min: [-55, 12, 16], max: [55, 18, 22] },
        ] },
        { featureId: featureId("Gusset Root Fillets"), kind: "fillet", radiusMm: 6, faceCount: 8, faceBoundsMm: Array.from({ length: 8 }, (_, index) => ({ min: [index < 4 ? -51 : 39, index % 2 ? 12 : -18, 16], max: [index < 4 ? -39 : 51, index % 2 ? 18 : -12, 61] })) },
        { featureId: featureId("Bearing Mouth Chamfers"), kind: "chamfer", distanceMm: 1, faceCount: 2, faceBoundsMm: [{ min: [-27, -12, 49], max: [27, -11, 103] }, { min: [-27, 11, 49], max: [27, 12, 103] }] },
        { featureId: featureId("Grease Port Entry Chamfer"), kind: "chamfer", distanceMm: 0.5, faceCount: 1, faceBoundsMm: [{ min: [-0.5, -0.5, 130.5], max: [0.5, 0.5, 131] }] },
        { featureId: featureId("Base Perimeter Chamfer"), kind: "chamfer", distanceMm: 2, faceCount: 8, faceBoundsMm: [
          { min: [-90, -55, 14], max: [90, -53, 16] }, { min: [-90, 53, 14], max: [90, 55, 16] },
          { min: [-90, -55, 14], max: [-88, 55, 16] }, { min: [88, -55, 14], max: [90, 55, 16] },
          { min: [-90, -55, 14], max: [90, -53, 16] }, { min: [-90, 53, 14], max: [90, 55, 16] },
          { min: [-90, -55, 14], max: [-88, 55, 16] }, { min: [88, -55, 14], max: [90, 55, 16] },
        ] },
      ],
      entities: [{ kind: "component", id: "root-component", name: "Readiness Fixture", nativeToken: "fake-root-token", semanticDescriptor: "component:Readiness Fixture" }],
    },
  };
}

function makeServer() {
  const server = new Server({ name: "MCP Server Adapter", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: scenario === "incompatible" ? tools.slice(0, 3) : tools }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (params.name === "fusion_mcp_read") {
      if (args.queryType === "apiDocumentation") {
        documentationReads += 1;
        const query = String(args.searchPattern);
        if (query === "setDistanceExtent") {
          return text({ classes: [{ name: "adsk.fusion.ExtrudeFeatureInput", signature: "setDistanceExtent(distance: adsk.core.ValueInput)" }] });
        }
        return text({ documentation: query });
      }
      if (args.queryType === "screenshot") {
        camera = { ...camera, eye: [9, 9, 9] };
        return text({ base64Data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" });
      }
    }
    if (params.name === "fusion_mcp_execute") {
      const operation = (args.object as Record<string, unknown> | undefined)?.operation;
      if (args.featureType === "document" && operation === "save") {
        saveCalls += 1;
        if (saveOutcome === "canceled") return text({ success: false, canceled: true, message: "Fusion Save was canceled." });
        if (saveOutcome === "failed") return text({ success: false, message: "Fusion Save failed." });
        provisionalSaved = true;
        return text({ success: true });
      }
      const script = String((args.object as Record<string, unknown> | undefined)?.script ?? "");
      if (script.includes("CHAMFER_FUSION_READINESS_V1")) return text(inspection());
      if (script.includes("CHAMFER_FUSION_ENGINEERING_SNAPSHOT_V1")) {
        if (delayPostInspection) {
          delayPostInspection = false;
          postInspectionStarted = true;
          await new Promise((resolve) => setTimeout(resolve, 1_500));
        }
        if ((model === "plate" || model === "bracket") && fixtureVariant === "unsupported-verification") return text({ document: inspection().document, snapshot: { unsupported: true } });
        return text(engineeringSnapshot());
      }
      if (script.includes("CHAMFER_FUSION_INSPECTION_DOCUMENT_V1")) return text({ document: inspection().document });
      if (script.includes("CHAMFER_FUSION_INSPECTION_CAMERA_V1")) return text({ camera });
      if (script.includes("CHAMFER_FUSION_SECTION_SHOW_V1")) return text({ activated: model === "bearing-housing", analysesVisible: true, sections: [] });
      if (script.includes("CHAMFER_FUSION_SECTION_RESTORE_V1")) return text({ restored: true });
      if (script.includes("CHAMFER_FUSION_CAMERA_RESTORE_V1")) {
        // Real Fusion restores the exact camera the script embeds, not a default
        // pose. Honoring it matters when a displaced-camera variant left the
        // camera moved: the next capture must be able to save and restore that
        // moved pose and honestly report success on a single inspection.
        if (fixtureVariant !== "displaced-camera") {
          const embedded = script.match(/state = json\.loads\((".*")\)/);
          camera = embedded
            ? JSON.parse(JSON.parse(embedded[1] as string)) as typeof camera
            : { eye: [1, 2, 3], target: [0, 0, 0], upVector: [0, 1, 0], cameraType: 0, perspectiveAngle: 0.5, viewExtents: 10, isFitView: false };
        }
        return text({ restored: fixtureVariant !== "displaced-camera" });
      }
      if (script.includes("CHAMFER_FUSION_CAMERA_V1")) return text({ camera });
      // Token-free engineering fingerprint: a read-only probe (never counted as
      // a mutation). Derive it from the current model so a verified rollback can
      // prove geometry restoration.
      if (script.includes("token-free engineering fingerprint")) {
        return text({ fingerprint: { designType: 1, defaultLengthUnits: "mm", model, cubeWidth } });
      }
      // Stdout-collapse guard probe: a read-only adapter health check.
      if (script.includes('{"guard": True}')) return text({ guard: true });
      if (script.includes("CHAMFER_FUSION_ATOMIC_ACTION_V1")) {
        mutationCalls += 1;
        if (actionOutcome === "delayed") await new Promise((resolve) => setTimeout(resolve, 1_500));
        if (actionOutcome === "timeout") return toolError("Fusion MCP request timed out after mutation began");
        if (actionOutcome === "disconnect") return toolError("Fusion MCP socket disconnected during mutation");
        if (actionOutcome === "unrelated-document-disconnect") {
          wrongDocumentActive = true;
          setTimeout(() => { wrongDocumentActive = false; }, 250);
          return toolError("Fusion MCP socket disconnected after the active document changed");
        }
        if (actionOutcome === "uncertain-disconnect") {
          undoStack.push({ model, cubeWidth });
          model = "cube";
          nativeUndoEntries = 1;
          return toolError("Fusion MCP socket disconnected after mutation");
        }
        if (actionOutcome === "verification-failure" || actionOutcome === "undo-failure") {
          nativeUndoEntries = 1;
          return text({ commandId: "ChamferAction_fusion_atomic_failure", undoEntries: 1 });
        }
        const reviewedTextBody = FUS_TEXT_001_ACTION_BODY.split("\n").map((line) => `            ${line}`).join("\n");
        const reviewedIndustrialBody = FUS_TEXT_002_ACTION_BODY.split("\n").map((line) => `            ${line}`).join("\n");
        const reviewedImageBody = FUS_IMAGE_001_ACTION_BODY.split("\n").map((line) => `            ${line}`).join("\n");
        undoStack.push({ model, cubeWidth });
        model = script.includes(reviewedImageBody) ? "bracket"
          : script.includes(reviewedIndustrialBody) ? "bearing-housing"
          : script.includes(reviewedTextBody) ? "plate" : "cube";
        if (actionOutcome === "delayed-inspection") delayPostInspection = true;
        if (fixtureVariant === "wrong-document") wrongDocumentActive = true;
        // The 35 mm resize marks the cube-edit flow, but the bracket and
        // industrial action bodies also contain "35 mm" parameters; gate on the
        // resolved model so those actions cannot poison the cube state (undo
        // would then never restore the pre-action fingerprint).
        if (model === "cube" && script.includes("35 mm")) cubeWidth = 35;
        nativeUndoEntries = 1;
        return text({ commandId: "ChamferAction_fusion_atomic_cube", undoEntries: 1 });
      }
      mutationCalls += 1;
      unmatchedScripts.push(script.slice(0, 600));
    }
    if (params.name === "fusion_mcp_update") {
      mutationCalls += 1;
      if (args.featureType === "undo" && actionOutcome === "undo-failure") return text({ success: false, message: "Fusion refused automatic Undo" });
      if (args.featureType === "undo") {
        const preceding = undoStack.pop();
        if (preceding) { model = preceding.model; cubeWidth = preceding.cubeWidth; }
        else { model = "empty"; cubeWidth = 20; }
        nativeUndoEntries = 0;
        wrongDocumentActive = false;
      }
    }
    return text({ success: true });
  });
  return server;
}

const app = createMcpExpressApp();
app.get("/health", (_req, res) => res.json({ ok: true, scenario }));
app.get("/trace", (_req, res) => res.json({ documentationReads, mutationCalls, nativeUndoEntries, saveCalls, hasSolid: model !== "empty", model, postInspectionStarted, unmatchedScripts }));
app.post("/trace/reset", (_req, res) => {
  documentationReads = 0;
  mutationCalls = 0;
  unmatchedScripts = [];
  nativeUndoEntries = 0;
  model = "empty";
  undoStack = [];
  camera = { eye: [1, 2, 3], target: [0, 0, 0], upVector: [0, 1, 0], cameraType: 0, perspectiveAngle: 0.5, viewExtents: 10, isFitView: false };
  delayPostInspection = false;
  postInspectionStarted = false;
  fixtureVariant = "passing";
  wrongDocumentActive = false;
  cubeWidth = 20;
  provisionalSaved = false;
  saveOutcome = "success";
  actionOutcome = "success";
  saveCalls = 0;
  res.json({ documentationReads, mutationCalls, nativeUndoEntries, saveCalls, hasSolid: false, model });
});
app.post("/action-outcome/:outcome", (req, res) => {
  const next = req.params.outcome;
  if (!isActionOutcome(next)) {
    return res.status(400).json({ error: "unknown action outcome" });
  }
  actionOutcome = next;
  return res.json({ actionOutcome });
});
app.post("/save-outcome/:outcome", (req, res) => {
  const next = req.params.outcome as typeof saveOutcome;
  if (!["success", "canceled", "failed"].includes(next)) return res.status(400).json({ error: "unknown save outcome" });
  saveOutcome = next;
  return res.json({ saveOutcome });
});
app.post("/fixture/:variant", (req, res) => {
  const next = req.params.variant as FixtureVariant;
  if (!["passing", "direct", "omitted-feature", "wrong-material", "wrong-appearance", "displaced-camera", "wrong-dimensions", "extra-history", "wrong-document", "unsupported-verification", "broken-datums", "mirrored-recess", "reversed-counterbores", "disconnected-gusset", "false-thread", "wrong-seat-fit", "wrong-feature-size", "reversed-upright", "wrong-face-holes", "swapped-diameters"].includes(next)) return res.status(400).json({ error: "unknown fixture variant" });
  fixtureVariant = next;
  return res.json({ fixtureVariant });
});
app.post("/manual/width/:value", (req, res) => {
  if (model === "empty") return res.status(409).json({ error: "no solid" });
  cubeWidth = Number(req.params.value);
  return res.json({ cubeWidth });
});
app.post("/control/:scenario", (req, res) => {
  const next = req.params.scenario as Scenario;
  if (!["unavailable", "incompatible", "no-document", "wrong-document", "provisional", "provisional-lost", "read-only", "busy", "unsupported", "degraded", "ready"].includes(next)) return res.status(400).json({ error: "unknown scenario" });
  scenario = next;
  if (next === "provisional") provisionalSaved = false;
  return res.json({ scenario });
});
app.all("/mcp", async (req, res) => {
  if (scenario === "unavailable") return res.status(503).json({ error: "offline" });
  const server = makeServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } finally {
    res.on("close", () => { void transport.close(); void server.close(); });
  }
});

app.listen(port, "127.0.0.1", () => console.log(`fake Fusion MCP on http://127.0.0.1:${port}/mcp`));
