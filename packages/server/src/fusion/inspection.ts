import { createHash } from "node:crypto";
import type {
  FusionBodyDto,
  FusionCheckInput,
  FusionCheckResultDto,
  FusionDocumentIdentityDto,
  FusionEngineeringSnapshotDto,
  FusionEntityDto,
  FusionEvidenceView,
  FusionFeatureDto,
  FusionFeatureMeasurementDto,
  FusionHoleDto,
  FusionMaterialDto,
  FusionParameterDto,
  FusionReferenceDto,
  FusionScreenshotDto,
  FusionSketchDto,
} from "@chamfer/shared";
import type { FusionMcpClient } from "./mcpClient";
import { executeFusionScript, isRecord, stableJson } from "./mcpPayload";
import {
  captureInspectionCameraScript,
  restoreInspectionSectionsScript,
  showInspectionSectionScript,
  engineeringSnapshotScript,
  inspectionDocumentIdentityScript,
  restoreInspectionCameraScript,
} from "./inspectionScripts";

const READ_TOOL = "fusion_mcp_read";
const VIEWS: ReadonlyArray<{ view: FusionEvidenceView; direction: string }> = [
  { view: "front", direction: "front" },
  { view: "back", direction: "back" },
  { view: "left", direction: "left" },
  { view: "right", direction: "right" },
  { view: "top", direction: "top" },
  { view: "bottom", direction: "bottom" },
  { view: "isometric", direction: "iso-top-right" },
  // The current MCP screenshot contract has no section direction. The trusted
  // inspector activates the fixture's native section analysis before this
  // front capture when one exists, so the evidence remains a normal MCP image.
  { view: "section", direction: "front" },
];

function string(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function number(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function boolean(value: unknown): boolean {
  return value === true;
}

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function sorted<T extends { id: string }>(values: T[]): T[] {
  return values.sort((a, b) => a.id.localeCompare(b.id));
}

function tuple3(value: unknown): [number, number, number] {
  const values = Array.isArray(value) ? value : [];
  return [number(values[0]), number(values[1]), number(values[2])];
}

function signatureData(value: unknown): Record<string, boolean | number | number[] | string> {
  if (!isRecord(value)) return {};
  const normalized: Record<string, boolean | number | number[] | string> = {};
  for (const [key, candidate] of Object.entries(value)) {
    if (typeof candidate === "boolean" || typeof candidate === "string") normalized[key] = candidate;
    else if (typeof candidate === "number" && Number.isFinite(candidate)) normalized[key] = candidate;
    if (Array.isArray(candidate) && candidate.every((item) => typeof item === "number" && Number.isFinite(item))) {
      normalized[key] = candidate as number[];
    }
  }
  return normalized;
}

function numberArray(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter((item): item is number => typeof item === "number" && Number.isFinite(item))
    : [];
}

export function canonicalizeFusionSnapshot(raw: unknown): FusionEngineeringSnapshotDto {
  if (!isRecord(raw)) throw new Error("Fusion inspector returned no engineering snapshot");
  const intent = isRecord(raw.designIntent) ? raw.designIntent : {};
  const units = isRecord(raw.units) ? raw.units : {};
  const parameters = sorted(recordArray(raw.parameters).map((value): FusionParameterDto => ({
    id: string(value.id), name: string(value.name), expression: string(value.expression),
    valueMm: number(value.valueMm), unit: string(value.unit),
    ...(typeof value.valueDegrees === "number" ? { valueDegrees: number(value.valueDegrees) } : {}),
  })));
  const sketches = sorted(recordArray(raw.sketches).map((value): FusionSketchDto => ({
    id: string(value.id), name: string(value.name), plane: string(value.plane),
    profiles: number(value.profiles), curves: number(value.curves),
    constraints: Array.isArray(value.constraints)
      ? value.constraints.filter((item): item is string => typeof item === "string").sort()
      : [],
    geometry: recordArray(value.geometry).map((item) => ({
      type: string(item.type),
      data: signatureData(item.data),
    })),
    constraintDetails: recordArray(value.constraintDetails).map((item) => ({
      type: string(item.type),
      references: Array.isArray(item.references)
        ? item.references.filter((reference): reference is string => typeof reference === "string")
        : [],
      ...(typeof item.parameter === "string" ? { parameter: item.parameter } : {}),
    })),
    ...(Array.isArray(value.dimensionExpressions) ? { dimensionExpressions: value.dimensionExpressions.filter((item): item is string => typeof item === "string").sort() } : {}),
    ...(typeof value.fullyConstrained === "boolean" ? { fullyConstrained: value.fullyConstrained } : {}),
  })));
  const features = sorted(recordArray(raw.features).map((value): FusionFeatureDto => ({
    id: string(value.id), name: string(value.name), type: string(value.type),
    timelineIndex: number(value.timelineIndex), suppressed: boolean(value.suppressed),
  })));
  const bodies = sorted(recordArray(raw.bodies).map((value): FusionBodyDto => ({
    id: string(value.id), name: string(value.name), solid: boolean(value.solid),
    volumeMm3: number(value.volumeMm3), boundingBoxMm: tuple3(value.boundingBoxMm),
    ...(typeof value.material === "string" ? { material: value.material } : {}),
    ...(typeof value.appearance === "string" ? { appearance: value.appearance } : {}),
    ...(Array.isArray(value.appearanceColor) ? { appearanceColor: tuple3(value.appearanceColor) } : {}),
    geometrySignature: {
      faceCount: number(isRecord(value.geometrySignature) ? value.geometrySignature.faceCount : undefined),
      edgeCount: number(isRecord(value.geometrySignature) ? value.geometrySignature.edgeCount : undefined),
      faceAreasMm2: numberArray(isRecord(value.geometrySignature) ? value.geometrySignature.faceAreasMm2 : undefined).sort((a, b) => a - b),
      edgeLengthsMm: numberArray(isRecord(value.geometrySignature) ? value.geometrySignature.edgeLengthsMm : undefined).sort((a, b) => a - b),
      boundingBoxMinMm: tuple3(isRecord(value.geometrySignature) ? value.geometrySignature.boundingBoxMinMm : undefined),
      boundingBoxMaxMm: tuple3(isRecord(value.geometrySignature) ? value.geometrySignature.boundingBoxMaxMm : undefined),
      centerOfMassMm: tuple3(isRecord(value.geometrySignature) ? value.geometrySignature.centerOfMassMm : undefined),
      bodyRevisionId: string(isRecord(value.geometrySignature) ? value.geometrySignature.bodyRevisionId : undefined),
      ...(isRecord(value.geometrySignature) && Array.isArray(value.geometrySignature.surfaceTypes)
        ? { surfaceTypes: value.geometrySignature.surfaceTypes.filter((item): item is string => typeof item === "string").sort() }
        : {}),
    },
  })));
  const materials = sorted(recordArray(raw.materials).map((value): FusionMaterialDto => ({
    id: string(value.id), name: string(value.name),
    ...(typeof value.libraryName === "string" ? { libraryName: value.libraryName } : {}),
  })));
  const holes = recordArray(raw.holes).map((value): FusionHoleDto => ({
    featureId: string(value.featureId),
    ...(typeof value.name === "string" ? { name: value.name } : {}),
    centerMm: tuple3(value.centerMm),
    diameterMm: number(value.diameterMm),
    through: boolean(value.through),
    ...(typeof value.counterboreDiameterMm === "number" ? { counterboreDiameterMm: number(value.counterboreDiameterMm) } : {}),
    ...(typeof value.counterboreDepthMm === "number" ? { counterboreDepthMm: number(value.counterboreDepthMm) } : {}),
    ...(value.direction === "positive" || value.direction === "negative" ? { direction: value.direction } : {}),
    ...(Array.isArray(value.normal) ? { normal: tuple3(value.normal) } : {}),
  })).sort((a, b) => a.featureId.localeCompare(b.featureId));
  const featureMeasurements = recordArray(raw.featureMeasurements).map((value): FusionFeatureMeasurementDto => ({
    featureId: string(value.featureId),
    kind: string(value.kind) as FusionFeatureMeasurementDto["kind"],
    ...(Array.isArray(value.centerMm) ? { centerMm: tuple3(value.centerMm) } : {}),
    ...(typeof value.diameterMm === "number" ? { diameterMm: number(value.diameterMm) } : {}),
    ...(typeof value.depthMm === "number" ? { depthMm: number(value.depthMm) } : {}),
    ...(typeof value.radiusMm === "number" ? { radiusMm: number(value.radiusMm) } : {}),
    ...(typeof value.distanceMm === "number" ? { distanceMm: number(value.distanceMm) } : {}),
    ...(typeof value.faceCount === "number" ? { faceCount: number(value.faceCount) } : {}),
    ...(value.axis === "x" || value.axis === "y" || value.axis === "z" ? { axis: value.axis } : {}),
    ...(value.direction === "positive" || value.direction === "negative" || value.direction === "symmetric" ? { direction: value.direction } : {}),
    ...(typeof value.widthMm === "number" ? { widthMm: number(value.widthMm) } : {}),
    ...(typeof value.heightMm === "number" ? { heightMm: number(value.heightMm) } : {}),
    ...(typeof value.thicknessMm === "number" ? { thicknessMm: number(value.thicknessMm) } : {}),
    ...(typeof value.crownRadiusMm === "number" ? { crownRadiusMm: number(value.crownRadiusMm) } : {}),
    ...(typeof value.pitchMm === "number" ? { pitchMm: number(value.pitchMm) } : {}),
    ...(typeof value.through === "boolean" ? { through: boolean(value.through) } : {}),
    ...(typeof value.threadDesignation === "string" ? { threadDesignation: value.threadDesignation } : {}),
    ...(typeof value.connectedBodyCount === "number" ? { connectedBodyCount: number(value.connectedBodyCount) } : {}),
    ...(typeof value.intersectsFeature === "string" ? { intersectsFeature: value.intersectsFeature } : {}),
    ...(typeof value.datumName === "string" ? { datumName: value.datumName } : {}),
    ...(Array.isArray(value.faceBoundsMm) ? { faceBoundsMm: recordArray(value.faceBoundsMm).map((bounds) => ({ min: tuple3(bounds.min), max: tuple3(bounds.max) })) } : {}),
    ...(typeof value.error === "string" ? { error: value.error } : {}),
    ...(typeof value.occurrenceCount === "number" ? { occurrenceCount: number(value.occurrenceCount) } : {}),
  })).sort((a, b) => a.featureId.localeCompare(b.featureId));
  const references = sorted(recordArray(raw.references).map((value): FusionReferenceDto => ({
    id: string(value.id), name: string(value.name),
    type: value.type === "axis" || value.type === "point" ? value.type : "plane",
    ...(Array.isArray(value.originMm) ? { originMm: tuple3(value.originMm) } : {}),
    ...(Array.isArray(value.normal) ? { normal: tuple3(value.normal) } : {}),
  })));
  const entities = sorted(recordArray(raw.entities).map((value): FusionEntityDto => ({
    kind: string(value.kind) as FusionEntityDto["kind"], id: string(value.id),
    name: string(value.name), nativeToken: string(value.nativeToken),
    ...(typeof value.chamferId === "string" ? { chamferId: value.chamferId } : {}),
    ...(typeof value.semanticDescriptor === "string" ? { semanticDescriptor: value.semanticDescriptor } : {}),
  })));
  return {
    designIntent: {
      designType: string(intent.designType),
      rootComponent: string(intent.rootComponent),
      timelineMarker: number(intent.timelineMarker),
    },
    units: {
      distance: string(units.distance), angle: string(units.angle),
      internalDistance: string(units.internalDistance),
    },
    parameters, sketches, features, bodies, materials, holes, featureMeasurements, references, entities,
  };
}

export function fingerprintFusionSnapshot(snapshot: FusionEngineeringSnapshotDto): string {
  const engineeringState = {
    ...snapshot,
    // Exclude fields that are not stable across an Undo/recompute round-trip (or
    // that Fusion re-derives non-deterministically), or the revision differs
    // without an engineering change and a correct action is misread as a manual
    // edit. `timelineMarker` is UI marker position; `rootComponent` flips between
    // "(Unsaved)" and "Untitled" as document state changes with no geometry
    // difference; each body's `bodyRevisionId` is Fusion's monotonic
    // change-counter (it advances whenever a body is touched and is not
    // guaranteed to return to its prior value after an undo/recompute). The
    // stable analytic geometry - bounding box, volume, face/edge counts, sorted
    // face areas and edge lengths - and the critical designType still fingerprint
    // the actual shape, so manual-edit detection remains sound.
    designIntent: (({ timelineMarker: _timelineMarker, rootComponent: _rootComponent, ...intent }) => intent)(snapshot.designIntent),
    // Native tokens are current-session lookup handles and may be reissued for
    // the same entity. Stable semantic/Chamfer ids remain in the fingerprint.
    entities: snapshot.entities.map(({ nativeToken: _nativeToken, ...entity }) => entity),
    bodies: snapshot.bodies.map((body) => ({
      ...body,
      geometrySignature: (({ bodyRevisionId: _bodyRevisionId, ...signature }) => signature)(body.geometrySignature),
    })),
  };
  return createHash("sha256").update(stableJson(engineeringState)).digest("hex");
}

function bodyFor(snapshot: FusionEngineeringSnapshotDto, bodyId: unknown): FusionBodyDto | undefined {
  return typeof bodyId === "string" ? snapshot.bodies.find((body) => body.id === bodyId) : snapshot.bodies[0];
}

export function evaluateFusionChecks(
  snapshot: FusionEngineeringSnapshotDto,
  checks: readonly FusionCheckInput[],
  evidence: { views: readonly FusionEvidenceView[]; cameraRestored: boolean } = { views: [], cameraRestored: false },
): FusionCheckResultDto[] {
  return checks.map((check) => {
    if (check.kind === "body-count" && "expected" in check && typeof check.expected === "number") {
      const passed = snapshot.bodies.length === check.expected;
      return { kind: check.kind, status: passed ? "passed" : "failed", detail: `Expected ${check.expected} bodies; found ${snapshot.bodies.length}.` };
    }
    if (check.kind === "dimensions" && "expectedMm" in check && Array.isArray(check.expectedMm)) {
      const body = bodyFor(snapshot, check.bodyId);
      if (!body) return { kind: check.kind, status: "failed", detail: "The requested body was not found." };
      // A bounding-box measurement carries sub-millimetre float noise, so an
      // omitted tolerance must not mean an exact float compare (which fails a
      // dimensionally-correct part). Fall back to 0.5 mm when unspecified.
      const tolerance = typeof check.toleranceMm === "number" ? check.toleranceMm : 0.5;
      const expected = tuple3(check.expectedMm);
      const passed = body.boundingBoxMm.every((value, index) => Math.abs(value - expected[index]!) <= tolerance);
      return { kind: check.kind, status: passed ? "passed" : "failed", detail: `Measured [${body.boundingBoxMm.join(", ")}] mm; expected [${expected.join(", ")}] mm ± ${tolerance} mm.` };
    }
    if (check.kind === "volume") {
      const body = bodyFor(snapshot, check.bodyId);
      if (!body) return { kind: check.kind, status: "failed", detail: "The requested body was not found." };
      if (typeof check.minMm3 !== "number" && typeof check.maxMm3 !== "number") {
        return { kind: check.kind, status: "failed", detail: "A volume check requires minMm3, maxMm3, or both." };
      }
      const min = typeof check.minMm3 === "number" ? check.minMm3 : -Infinity;
      const max = typeof check.maxMm3 === "number" ? check.maxMm3 : Infinity;
      const passed = body.volumeMm3 >= min && body.volumeMm3 <= max;
      return { kind: check.kind, status: passed ? "passed" : "failed", detail: `Measured ${body.volumeMm3} mm³; required range ${min}–${max} mm³.` };
    }
    if (check.kind === "parameter" && "name" in check && typeof check.name === "string") {
      const parameter = snapshot.parameters.find((candidate) => candidate.name === check.name);
      const tolerance = typeof check.toleranceMm === "number" ? check.toleranceMm : 0;
      const expected = typeof check.expectedMm === "number" ? check.expectedMm : Number.NaN;
      const passed = Boolean(parameter) && Number.isFinite(expected) && Math.abs(parameter!.valueMm - expected) <= tolerance;
      return { kind: check.kind, status: passed ? "passed" : "failed", detail: `Parameter ${check.name} is ${parameter?.valueMm ?? "missing"} mm; expected ${expected} mm ± ${tolerance} mm.` };
    }
    if (check.kind === "angle-parameter" && "name" in check && typeof check.name === "string" &&
        typeof check.expectedDegrees === "number" && typeof check.toleranceDegrees === "number") {
      const parameter = snapshot.parameters.find((candidate) => candidate.name === check.name);
      const passed = typeof parameter?.valueDegrees === "number" &&
        Math.abs(parameter.valueDegrees - check.expectedDegrees) <= check.toleranceDegrees;
      return { kind: check.kind, status: passed ? "passed" : "failed",
        detail: `Angle parameter ${check.name} is ${parameter?.valueDegrees ?? "missing"}°; expected ${check.expectedDegrees}° ± ${check.toleranceDegrees}°.` };
    }
    if (check.kind === "fully-constrained-sketches" && typeof check.minCount === "number" && typeof check.requireAll === "boolean") {
      const constrained = snapshot.sketches.filter((sketch) => sketch.fullyConstrained === true);
      const passed = constrained.length >= check.minCount && (!check.requireAll || constrained.length === snapshot.sketches.length);
      return { kind: check.kind, status: passed ? "passed" : "failed",
        detail: `${constrained.length} of ${snapshot.sketches.length} sketches are natively fully constrained; required at least ${check.minCount}${check.requireAll ? " and all sketches" : ""}.` };
    }
    if (check.kind === "circular-pattern" && "name" in check && typeof check.name === "string" && typeof check.expectedOccurrences === "number") {
      const feature = snapshot.features.find((candidate) => candidate.type === "CircularPatternFeature" && candidate.name === check.name);
      const measurement = feature && snapshot.featureMeasurements?.find((candidate) =>
        candidate.featureId === feature.id && candidate.kind === "circular-pattern");
      const passed = measurement?.occurrenceCount === check.expectedOccurrences;
      return { kind: check.kind, status: passed ? "passed" : "failed",
        detail: `Circular pattern ${check.name} contains ${measurement?.occurrenceCount ?? "missing"} occurrences; expected ${check.expectedOccurrences}.` };
    }
    if (check.kind === "feature" && "featureType" in check && typeof check.featureType === "string") {
      const matching = snapshot.features.filter((feature) => feature.type === check.featureType
        && (!("name" in check) || typeof check.name !== "string" || feature.name === check.name));
      const count = matching.length;
      const minimum = typeof check.minCount === "number" ? check.minCount : 1;
      const maximum = typeof check.maxCount === "number" ? check.maxCount : Infinity;
      const expectedSize = typeof check.expectedSizeMm === "number" ? check.expectedSizeMm : undefined;
      const tolerance = typeof check.toleranceMm === "number" ? check.toleranceMm : 0;
      const countPassed = count >= minimum && count <= maximum;
      // Only fillet radius and chamfer distance are measurable sizes; an
      // expectedSizeMm on any other feature type is not evaluable and must be
      // reported as unsupported (never silently passed, but also never a
      // "failed" that rolls back a correct feature the inspector simply
      // cannot measure).
      const sizeMeasurable = check.featureType === "FilletFeature" || check.featureType === "ChamferFeature";
      if (expectedSize !== undefined && !sizeMeasurable) {
        return { kind: check.kind, status: countPassed ? "unsupported" : "failed",
          detail: `Found ${count} ${check.featureType} features; required ${minimum}–${maximum === Infinity ? "unbounded" : maximum}. expectedSizeMm is not measurable for ${check.featureType} (only FilletFeature radius and ChamferFeature distance are); assert this feature's geometry with a volume, dimensions, or holes check instead, or drop expectedSizeMm.` };
      }
      const measurements = expectedSize === undefined ? [] : matching.map((feature) =>
        snapshot.featureMeasurements?.find((measurement) => measurement.featureId === feature.id));
      const measuredSizes = measurements.map((measurement) => check.featureType === "FilletFeature"
        ? measurement?.radiusMm : measurement?.distanceMm);
      const sizePassed = expectedSize === undefined || (measuredSizes.length === count && measuredSizes.every((size) =>
        typeof size === "number" && Math.abs(size - expectedSize) <= tolerance));
      const passed = countPassed && sizePassed;
      return { kind: check.kind, status: passed ? "passed" : "failed", detail: `Found ${count} ${check.featureType} features; required ${minimum}–${maximum === Infinity ? "unbounded" : maximum}${expectedSize === undefined ? "" : `; measured sizes [${measuredSizes.map((size) => size ?? "missing").join(", ")}] mm, expected ${expectedSize} ± ${tolerance} mm`}.` };
    }
    if (check.kind === "material" && "expected" in check && typeof check.expected === "string") {
      const body = bodyFor(snapshot, check.bodyId);
      const accepted = [check.expected, ...(Array.isArray(check.acceptedEquivalents) ? check.acceptedEquivalents.filter((item): item is string => typeof item === "string") : [])];
      const material = snapshot.materials.find((candidate) => candidate.name === body?.material);
      const provenanceRequired = check.requireLibraryProvenance === true;
      // Family/substring match (case-insensitive, locale-independent): a declared
      // "Aluminum" must accept Fusion's actual "Aluminum 6061", and vice versa.
      // Exact equality here false-fails every real library material.
      const bodyMaterial = (body?.material ?? "").toLowerCase();
      const passed = Boolean(body?.material)
        && accepted.some((name) => {
          const expected = name.toLowerCase();
          return bodyMaterial === expected || bodyMaterial.includes(expected) || expected.includes(bodyMaterial);
        })
        && (!provenanceRequired || Boolean(material?.libraryName));
      return {
        kind: check.kind,
        status: passed ? "passed" : "failed",
        detail: `Material is ${body?.material ?? "unassigned"} from ${material?.libraryName ?? "an unknown library"}; accepted canonical mapping: ${accepted.join(", ")}.`,
      };
    }
    if (check.kind === "holes" && "expected" in check && typeof check.expected === "number") {
      const body = bodyFor(snapshot, check.bodyId);
      const holes = snapshot.holes ?? [];
      const tolerance = typeof check.toleranceMm === "number" ? check.toleranceMm : 0;
      const expectedDiameter = typeof check.diameterMm === "number" ? check.diameterMm : undefined;
      const expectedOffset = typeof check.edgeOffsetMm === "number" ? check.edgeOffsetMm : undefined;
      const min = body?.geometrySignature.boundingBoxMinMm;
      const max = body?.geometrySignature.boundingBoxMaxMm;
      const valid = holes.filter((hole) => {
        if (expectedDiameter !== undefined && Math.abs(hole.diameterMm - expectedDiameter) > tolerance) return false;
        if (typeof check.through === "boolean" && hole.through !== check.through) return false;
        if (expectedOffset !== undefined) {
          if (!min || !max) return false;
          const xOffset = Math.min(Math.abs(hole.centerMm[0] - min[0]), Math.abs(max[0] - hole.centerMm[0]));
          const yOffset = Math.min(Math.abs(hole.centerMm[1] - min[1]), Math.abs(max[1] - hole.centerMm[1]));
          if (Math.abs(xOffset - expectedOffset) > tolerance || Math.abs(yOffset - expectedOffset) > tolerance) return false;
        }
        return true;
      });
      return { kind: check.kind, status: holes.length === check.expected && valid.length === check.expected ? "passed" : "failed",
        detail: `Found ${holes.length} native holes; ${valid.length} satisfy diameter, through-state, and edge-offset requirements; expected ${check.expected}. Measurements: ${holes.map((hole) => `${hole.featureId}@${hole.centerMm.join(",")}:${hole.diameterMm}mm:${hole.through ? "through" : "blind"}`).join("; ")}.` };
    }
    if (check.kind === "named-references" && "names" in check && Array.isArray(check.names)) {
      const required = check.names.filter((name): name is string => typeof name === "string");
      const found = snapshot.references?.filter((reference) => reference.type === check.referenceType && required.includes(reference.name)) ?? [];
      const missing = required.filter((name) => !found.some((reference) => reference.name === name));
      const tolerance = typeof check.toleranceMm === "number" ? check.toleranceMm : 0;
      const expectedOrigins = Array.isArray(check.expectedOriginsMm) ? check.expectedOriginsMm : [];
      const expectedNormals = Array.isArray(check.expectedNormals) ? check.expectedNormals : [];
      const misplaced = required.filter((name, index) => {
        if (!expectedOrigins[index]) return false;
        const actual = found.find((reference) => reference.name === name)?.originMm;
        return !actual || actual.some((value, axis) => Math.abs(value - numberArray(expectedOrigins[index])[axis]!) > tolerance);
      });
      const misoriented = required.filter((name, index) => {
        if (!expectedNormals[index]) return false;
        const actual = found.find((reference) => reference.name === name)?.normal;
        const expected = numberArray(expectedNormals[index]);
        return !actual || Math.abs(Math.abs(actual[0] * expected[0]! + actual[1] * expected[1]! + actual[2] * expected[2]!) - 1) > 0.001;
      });
      return { kind: check.kind, status: missing.length === 0 && misplaced.length === 0 && misoriented.length === 0 ? "passed" : "failed", detail: missing.length === 0 && misplaced.length === 0 && misoriented.length === 0
        ? `Found stable named ${check.referenceType} references at their declared datum positions: ${required.join(", ")}.`
        : `Missing references: ${missing.join(", ") || "none"}; misplaced references: ${misplaced.join(", ") || "none"}; misoriented references: ${misoriented.join(", ") || "none"}.` };
    }
    if (check.kind === "parametric-sketch" && "name" in check && typeof check.name === "string" && Array.isArray(check.requiredExpressions)) {
      const normalize = (value: string) => value.replace(/\s+/g, "").toLocaleLowerCase();
      const required = check.requiredExpressions.filter((item): item is string => typeof item === "string");
      const sketches = snapshot.sketches.filter((candidate) => candidate.name === check.name);
      const linked = sketches.some((sketch) => required.every((expression) => sketch.dimensionExpressions?.some((actual) => normalize(actual) === normalize(expression))));
      return { kind: check.kind, status: linked ? "passed" : "failed", detail: linked
        ? `${check.name} retains driving dimensions for ${required.join(", ")}.`
        : `${check.name} is missing driving dimension expressions: ${required.join(", ")}.` };
    }
    if (check.kind === "bore" && "name" in check && typeof check.name === "string") {
      const feature = snapshot.features.find((candidate) => candidate.name === check.name);
      const measurement = feature && snapshot.featureMeasurements?.find((candidate) => candidate.featureId === feature.id && candidate.kind === "bore");
      const parameter = "nominalParameter" in check && typeof check.nominalParameter === "string"
        ? snapshot.parameters.find((candidate) => candidate.name === check.nominalParameter) : undefined;
      const center = Array.isArray(check.centerMm) ? tuple3(check.centerMm) : [Number.NaN, Number.NaN, Number.NaN];
      const tolerance = typeof check.toleranceMm === "number" ? check.toleranceMm : 0;
      const centerOk = Boolean(measurement?.centerMm) && measurement!.centerMm!.every((value, index) => Math.abs(value - center[index]!) <= tolerance);
      const diameterOk = typeof measurement?.diameterMm === "number" && typeof check.minDiameterMm === "number" && typeof check.maxDiameterMm === "number"
        && measurement.diameterMm >= check.minDiameterMm && measurement.diameterMm <= check.maxDiameterMm;
      const nominal = typeof check.nominalMm === "number" ? check.nominalMm : Number.NaN;
      const passed = Boolean(parameter) && Math.abs(parameter!.valueMm - nominal) <= tolerance && centerOk && diameterOk && measurement?.axis === check.axis && measurement?.through === check.through;
      return { kind: check.kind, status: passed ? "passed" : "failed", detail: `Native bore ${check.name}: center [${measurement?.centerMm?.join(", ") ?? "missing"}], diameter ${measurement?.diameterMm ?? "missing"} mm, axis ${measurement?.axis ?? "missing"}, through ${measurement?.through ?? "missing"}; nominal parameter ${parameter?.valueMm ?? "missing"} mm.` };
    }
    if (check.kind === "housing-profile" && "name" in check && typeof check.name === "string") {
      const feature = snapshot.features.find((candidate) => candidate.name === check.name);
      const measurement = feature && snapshot.featureMeasurements?.find((candidate) => candidate.featureId === feature.id && candidate.kind === "housing-profile");
      const tolerance = typeof check.toleranceMm === "number" ? check.toleranceMm : 0;
      const expectedCenter = Array.isArray(check.axisCenterMm) ? tuple3(check.axisCenterMm) : [Number.NaN, Number.NaN, Number.NaN];
      const centerOk = Boolean(measurement?.centerMm) && measurement!.centerMm!.every((value, index) => Math.abs(value - expectedCenter[index]!) <= tolerance);
      const passed = Boolean(measurement) && centerOk && typeof check.wallWidthMm === "number" && typeof check.wallThicknessMm === "number" && typeof check.crownRadiusMm === "number"
        && Math.abs((measurement!.widthMm ?? Number.NaN) - check.wallWidthMm) <= tolerance
        && Math.abs((measurement!.thicknessMm ?? Number.NaN) - check.wallThicknessMm) <= tolerance
        && Math.abs((measurement!.crownRadiusMm ?? Number.NaN) - check.crownRadiusMm) <= tolerance;
      return { kind: check.kind, status: passed ? "passed" : "failed", detail: `Native wall/crown profile is ${measurement?.widthMm ?? "missing"} x ${measurement?.thicknessMm ?? "missing"} mm with R${measurement?.crownRadiusMm ?? "missing"} crown at [${measurement?.centerMm?.join(", ") ?? "missing"}].` };
    }
    if (check.kind === "directional-recess" && "name" in check && typeof check.name === "string") {
      const feature = snapshot.features.find((candidate) => candidate.name === check.name);
      const measurement = feature && snapshot.featureMeasurements?.find((candidate) => candidate.featureId === feature.id && candidate.kind === "recess");
      const tolerance = typeof check.toleranceMm === "number" ? check.toleranceMm : 0;
      const passed = Boolean(measurement) && typeof check.diameterMm === "number" && typeof check.depthMm === "number"
        && Math.abs(measurement!.diameterMm! - check.diameterMm) <= tolerance
        && Math.abs(measurement!.depthMm! - check.depthMm) <= tolerance
        && measurement!.datumName === check.datumName && measurement!.direction === check.direction && measurement!.through === false;
      return { kind: check.kind, status: passed ? "passed" : "failed", detail: `Native recess ${check.name}: diameter ${measurement?.diameterMm ?? "missing"} mm, depth ${measurement?.depthMm ?? "missing"} mm, datum ${measurement?.datumName ?? "missing"}, direction ${measurement?.direction ?? "missing"}, through ${measurement?.through ?? "missing"}.` };
    }
    if (check.kind === "counterbored-holes" && "expected" in check && typeof check.expected === "number") {
      const tolerance = typeof check.toleranceMm === "number" ? check.toleranceMm : 0;
      const centers = Array.isArray(check.centersMm) ? check.centersMm.map(tuple3) : [];
      const holeDiameter = typeof check.holeDiameterMm === "number" ? check.holeDiameterMm : Number.NaN;
      const counterboreDiameter = typeof check.counterboreDiameterMm === "number" ? check.counterboreDiameterMm : Number.NaN;
      const counterboreDepth = typeof check.counterboreDepthMm === "number" ? check.counterboreDepthMm : Number.NaN;
      const holes = (snapshot.holes ?? []).filter((hole) => hole.name?.startsWith("Counterbored Mounting Holes"));
      const valid = holes.filter((hole) => Math.abs(hole.diameterMm - holeDiameter) <= tolerance
        && hole.through && Math.abs((hole.counterboreDiameterMm ?? Number.NaN) - counterboreDiameter) <= tolerance
        && Math.abs((hole.counterboreDepthMm ?? Number.NaN) - counterboreDepth) <= tolerance && hole.direction === check.direction
        && centers.some((center) => hole.centerMm.every((value, index) => Math.abs(value - center[index]!) <= tolerance)));
      return { kind: check.kind, status: holes.length === check.expected && valid.length === check.expected ? "passed" : "failed", detail: `${valid.length}/${holes.length} native mounting holes match the ${holeDiameter} mm through / ${counterboreDiameter} x ${counterboreDepth} mm ${check.direction} counterbore contract.` };
    }
    if (check.kind === "gussets" && "expected" in check && typeof check.expected === "number") {
      const tolerance = typeof check.toleranceMm === "number" ? check.toleranceMm : 0;
      const centersX = Array.isArray(check.centersXmm) ? numberArray(check.centersXmm) : [];
      const wallFacesY = Array.isArray(check.wallFacesYmm) ? numberArray(check.wallFacesYmm) : [];
      const width = typeof check.widthMm === "number" ? check.widthMm : Number.NaN;
      const height = typeof check.heightMm === "number" ? check.heightMm : Number.NaN;
      const gussets = snapshot.featureMeasurements?.filter((measurement) => measurement.kind === "gusset") ?? [];
      const valid = gussets.filter((gusset) => typeof gusset.centerMm !== "undefined"
        && centersX.some((x) => Math.abs(gusset.centerMm![0] - x) <= tolerance)
        && wallFacesY.some((y) => Math.abs(gusset.centerMm![1] - y) <= tolerance)
        && Math.abs((gusset.widthMm ?? Number.NaN) - width) <= tolerance
        && Math.abs((gusset.heightMm ?? Number.NaN) - height) <= tolerance
        && gusset.connectedBodyCount === check.connectedBodyCount);
      return { kind: check.kind, status: gussets.length === check.expected && valid.length === check.expected ? "passed" : "failed", detail: `${valid.length}/${gussets.length} gussets match width, height, datum-relative position, and one-body connectivity.` };
    }
    if (check.kind === "threaded-hole" && "name" in check && typeof check.name === "string") {
      const feature = snapshot.features.find((candidate) => candidate.name === check.name);
      const measurement = feature && snapshot.featureMeasurements?.find((candidate) => candidate.featureId === feature.id && candidate.kind === "threaded-hole");
      const center = Array.isArray(check.centerMm) ? tuple3(check.centerMm) : [Number.NaN, Number.NaN, Number.NaN];
      const tolerance = typeof check.toleranceMm === "number" ? check.toleranceMm : 0;
      const diameter = typeof check.diameterMm === "number" ? check.diameterMm : Number.NaN;
      const pitch = typeof check.pitchMm === "number" ? check.pitchMm : Number.NaN;
      const centerOk = Boolean(measurement?.centerMm) && measurement!.centerMm!.every((value, index) => Math.abs(value - center[index]!) <= tolerance);
      const passed = Boolean(measurement) && centerOk && Math.abs((measurement!.diameterMm ?? Number.NaN) - diameter) <= tolerance
        && Math.abs((measurement!.pitchMm ?? Number.NaN) - pitch) <= tolerance && measurement!.axis === check.axis
        && measurement!.direction === check.direction && measurement!.intersectsFeature === check.intersectsFeature
        && typeof measurement!.threadDesignation === "string" && measurement!.threadDesignation!.toLocaleLowerCase().includes("m6");
      return { kind: check.kind, status: passed ? "passed" : "failed", detail: `Native threaded hole ${check.name}: ${measurement?.threadDesignation ?? "missing thread"}, pitch ${measurement?.pitchMm ?? "missing"} mm, axis ${measurement?.axis ?? "missing"}, intersection ${measurement?.intersectsFeature ?? "missing"}.` };
    }
    if (check.kind === "edge-treatment" && "name" in check && typeof check.name === "string"
      && (check.treatment === "fillet" || check.treatment === "chamfer")
      && typeof check.sizeMm === "number" && typeof check.minFaceCount === "number"
      && typeof check.toleranceMm === "number" && typeof check.placement === "string") {
      const treatment = check.treatment;
      const sizeMm = check.sizeMm;
      const minFaceCount = check.minFaceCount;
      const tolerance = check.toleranceMm;
      const expectedType = treatment === "fillet" ? "FilletFeature" : "ChamferFeature";
      const feature = snapshot.features.find((candidate) => candidate.name === check.name && candidate.type === expectedType);
      const measurement = feature && snapshot.featureMeasurements?.find((candidate) => candidate.featureId === feature.id && candidate.kind === treatment);
      const actualSize = treatment === "fillet" ? measurement?.radiusMm : measurement?.distanceMm;
      const bounds = measurement?.faceBoundsMm ?? [];
      const parameter = (name: string) => snapshot.parameters.find((candidate) => candidate.name === name)?.valueMm ?? Number.NaN;
      const body = snapshot.bodies[0];
      const min = body?.geometrySignature.boundingBoxMinMm;
      const max = body?.geometrySignature.boundingBoxMaxMm;
      let placementOk = false;
      if (check.placement === "wall-roots") {
        const baseTop = parameter("base_thickness");
        const halfWall = parameter("wall_thickness") / 2;
        placementOk = bounds.length >= minFaceCount && bounds.every((face) => face.min[2] <= baseTop + sizeMm + tolerance
          && (Math.abs(Math.abs(face.min[1]) - halfWall) <= sizeMm + tolerance || Math.abs(Math.abs(face.max[1]) - halfWall) <= sizeMm + tolerance));
      } else if (check.placement === "gusset-roots") {
        const x = parameter("gusset_x_offset");
        placementOk = bounds.length >= minFaceCount && bounds.every((face) => Math.abs(Math.abs((face.min[0] + face.max[0]) / 2) - x) <= parameter("gusset_width") / 2 + sizeMm + tolerance);
      } else if (check.placement === "bearing-mouths") {
        const axisZ = parameter("bearing_axis_height");
        const halfWall = parameter("wall_thickness") / 2;
        const axialSides = new Set(bounds.map((face) => Math.abs(face.max[1] - halfWall) <= sizeMm + tolerance ? "positive"
          : Math.abs(face.min[1] + halfWall) <= sizeMm + tolerance ? "negative" : "other"));
        placementOk = bounds.length >= minFaceCount && axialSides.has("positive") && axialSides.has("negative")
          && bounds.every((face) => face.min[2] <= axisZ + parameter("bearing_seat_nominal") / 2 + tolerance && face.max[2] >= axisZ - parameter("bearing_seat_nominal") / 2 - tolerance);
      } else if (check.placement === "grease-entry") {
        const crownTop = parameter("bearing_axis_height") + parameter("crown_radius");
        placementOk = bounds.length >= minFaceCount && bounds.every((face) => face.max[2] >= crownTop - sizeMm - tolerance
          && face.min[0] <= tolerance && face.max[0] >= -tolerance && face.min[1] <= tolerance && face.max[1] >= -tolerance);
      } else if (check.placement === "base-top-outer-perimeter" && min && max) {
        const baseTop = parameter("base_thickness");
        const sideCoverage = new Set(bounds.flatMap((face) => [
          ...(Math.abs(face.min[0] - min[0]) <= sizeMm + tolerance ? ["left"] : []),
          ...(Math.abs(face.max[0] - max[0]) <= sizeMm + tolerance ? ["right"] : []),
          ...(Math.abs(face.min[1] - min[1]) <= sizeMm + tolerance ? ["front"] : []),
          ...(Math.abs(face.max[1] - max[1]) <= sizeMm + tolerance ? ["back"] : []),
        ]));
        placementOk = bounds.length >= minFaceCount && ["left", "right", "front", "back"].every((side) => sideCoverage.has(side))
          && bounds.every((face) => face.min[2] >= baseTop - sizeMm - tolerance && face.max[2] <= baseTop + tolerance);
      }
      const passed = Boolean(measurement) && typeof actualSize === "number" && Math.abs(actualSize - sizeMm) <= tolerance
        && (measurement?.faceCount ?? 0) >= minFaceCount && placementOk;
      return { kind: check.kind, status: passed ? "passed" : "failed", detail: `${check.name} measured ${actualSize ?? "missing"} mm across ${measurement?.faceCount ?? 0} native faces; placement ${placementOk ? "matches" : "does not match"} ${check.placement}.` };
    }
    if (check.kind === "hole-pattern" && "expected" in check && typeof check.expected === "number") {
      const tolerance = typeof check.toleranceMm === "number" ? check.toleranceMm : 0;
      const expectedCenters = Array.isArray(check.centersMm) ? check.centersMm.map(tuple3) : [];
      const expectedNormal = Array.isArray(check.normal) ? tuple3(check.normal) : [Number.NaN, Number.NaN, Number.NaN];
      const diameter = typeof check.diameterMm === "number" ? check.diameterMm : Number.NaN;
      const candidates = (snapshot.holes ?? []).filter((hole) =>
        Math.abs(hole.diameterMm - diameter) <= tolerance && hole.through === check.through && Boolean(hole.normal) &&
        hole.normal!.every((value, index) => Math.abs(Math.abs(value) - Math.abs(expectedNormal[index]!)) <= 0.001));
      const unmatched = [...candidates];
      const centersMatch = expectedCenters.every((expected) => {
        const index = unmatched.findIndex((hole) => hole.centerMm.every((value, axis) => Math.abs(value - expected[axis]!) <= tolerance));
        if (index < 0) return false;
        unmatched.splice(index, 1);
        return true;
      });
      const passed = expectedCenters.length === check.expected && candidates.length === check.expected && centersMatch;
      return { kind: check.kind, status: passed ? "passed" : "failed",
        detail: `Found ${candidates.length} native ${diameter} mm holes normal to [${expectedNormal.join(", ")}]; expected centers ${expectedCenters.map((center) => `[${center.join(", ")}]`).join(", ")}.` };
    }
    if (check.kind === "pocket" && "name" in check && typeof check.name === "string") {
      const feature = snapshot.features.find((candidate) => candidate.name === check.name && candidate.type === "ExtrudeFeature");
      const measurement = feature && snapshot.featureMeasurements?.find((candidate) => candidate.featureId === feature.id && candidate.kind === "pocket");
      const tolerance = typeof check.toleranceMm === "number" ? check.toleranceMm : 0;
      const expectedCenter = Array.isArray(check.centerMm) ? check.centerMm : [Number.NaN, Number.NaN];
      const centerOk = Boolean(measurement?.centerMm) && measurement!.centerMm!.slice(0, 2).every((value, index) => Math.abs(value - expectedCenter[index]!) <= tolerance);
      const passed = Boolean(measurement) && centerOk && typeof check.diameterMm === "number" && typeof check.depthMm === "number"
        && Math.abs(measurement!.diameterMm! - check.diameterMm) <= tolerance
        && Math.abs(measurement!.depthMm! - check.depthMm) <= tolerance;
      return { kind: check.kind, status: passed ? "passed" : "failed", detail: `Native pocket ${check.name}: center [${measurement?.centerMm?.join(", ") ?? "missing"}], diameter ${measurement?.diameterMm ?? "missing"} mm, depth ${measurement?.depthMm ?? "missing"} mm.` };
    }
    if ((check.kind === "fillet" || check.kind === "chamfer") && "name" in check && typeof check.name === "string") {
      const expectedType = check.kind === "fillet" ? "FilletFeature" : "ChamferFeature";
      const feature = snapshot.features.find((candidate) => candidate.name === check.name && candidate.type === expectedType);
      const measurement = feature && snapshot.featureMeasurements?.find((candidate) => candidate.featureId === feature.id && candidate.kind === check.kind);
      const tolerance = typeof check.toleranceMm === "number" ? check.toleranceMm : 0;
      const expectedSize = check.kind === "fillet" && "radiusMm" in check ? check.radiusMm : "distanceMm" in check ? check.distanceMm : Number.NaN;
      const actualSize = check.kind === "fillet" ? measurement?.radiusMm : measurement?.distanceMm;
      const body = snapshot.bodies[0];
      const bounds = measurement?.faceBoundsMm ?? [];
      const bodyMin = body?.geometrySignature.boundingBoxMinMm;
      const bodyMax = body?.geometrySignature.boundingBoxMaxMm;
      let placementOk = false;
      if (bodyMin && bodyMax && check.kind === "fillet" && check.placement === "vertical-outer-corners") {
        const corners = new Set(bounds.filter((face) => {
          const touchesX = Math.abs(face.min[0] - bodyMin[0]) <= tolerance || Math.abs(face.max[0] - bodyMax[0]) <= tolerance;
          const touchesY = Math.abs(face.min[1] - bodyMin[1]) <= tolerance || Math.abs(face.max[1] - bodyMax[1]) <= tolerance;
          return touchesX && touchesY && face.max[2] - face.min[2] > (bodyMax[2] - bodyMin[2]) / 2;
        }).map((face) => `${(face.min[0] + face.max[0]) / 2 < (bodyMin[0] + bodyMax[0]) / 2 ? "-" : "+"}${(face.min[1] + face.max[1]) / 2 < (bodyMin[1] + bodyMax[1]) / 2 ? "-" : "+"}`));
        placementOk = corners.size === 4;
      }
      if (bodyMin && bodyMax && check.kind === "fillet" && check.placement === "base-vertical-outer-corners") {
        const baseHeight = snapshot.parameters.find((parameter) => parameter.name === "base_thickness")?.valueMm ?? Number.NaN;
        const corners = new Set(bounds.filter((face) => {
          const touchesX = Math.abs(face.min[0] - bodyMin[0]) <= tolerance || Math.abs(face.max[0] - bodyMax[0]) <= tolerance;
          const touchesY = Math.abs(face.min[1] - bodyMin[1]) <= tolerance || Math.abs(face.max[1] - bodyMax[1]) <= tolerance;
          return touchesX && touchesY && face.min[2] <= bodyMin[2] + tolerance && face.max[2] <= bodyMin[2] + baseHeight + tolerance;
        }).map((face) => `${(face.min[0] + face.max[0]) / 2 < (bodyMin[0] + bodyMax[0]) / 2 ? "-" : "+"}${(face.min[1] + face.max[1]) / 2 < (bodyMin[1] + bodyMax[1]) / 2 ? "-" : "+"}`));
        placementOk = corners.size === 4;
      }
      if (bodyMin && bodyMax && check.kind === "chamfer" && check.placement === "top-bottom-outer-perimeter") {
        const distance = typeof check.distanceMm === "number" ? check.distanceMm : Number.NaN;
        placementOk = bounds.length === check.faceCount && bounds.every((face) => {
          const touchesOuter = Math.abs(face.min[0] - bodyMin[0]) <= tolerance || Math.abs(face.max[0] - bodyMax[0]) <= tolerance
            || Math.abs(face.min[1] - bodyMin[1]) <= tolerance || Math.abs(face.max[1] - bodyMax[1]) <= tolerance;
          const staysInEndBand = face.max[2] <= bodyMin[2] + distance + tolerance || face.min[2] >= bodyMax[2] - distance - tolerance;
          return touchesOuter && staysInEndBand;
        });
      }
      const passed = Boolean(measurement) && typeof expectedSize === "number" && typeof actualSize === "number"
        && Math.abs(actualSize - expectedSize) <= tolerance
        && "faceCount" in check && measurement!.faceCount === check.faceCount && placementOk;
      return { kind: check.kind, status: passed ? "passed" : "failed", detail: `Native ${check.kind} ${check.name}: size ${actualSize ?? "missing"} mm produced ${measurement?.faceCount ?? "missing"} feature faces; placement ${placementOk ? "matches" : "does not match"} ${check.placement}${measurement?.error ? `; inspection error: ${measurement.error}` : ""}.` };
    }
    if (check.kind === "appearance" && "targetRgb" in check && Array.isArray(check.targetRgb)) {
      const body = bodyFor(snapshot, check.bodyId);
      const expected = tuple3(check.targetRgb);
      // Anodized/painted finishes rarely expose a colour exactly equal to a
      // declared triple; an omitted tolerance must not mean exact-RGB (which
      // always fails). Default to a generous band on the 0-255 scale - the
      // agent should prefer visual-evidence when it only needs to show a finish.
      const tolerance = typeof check.tolerance === "number" ? check.tolerance : 40;
      const actual = body?.appearanceColor;
      const passed = Boolean(actual) && actual!.every((channel, index) => Math.abs(channel - expected[index]!) <= tolerance);
      return { kind: check.kind, status: passed ? "passed" : "failed", detail: `Appearance ${body?.appearance ?? "unassigned"} has RGB [${actual?.join(", ") ?? "unavailable"}]; expected [${expected.join(", ")}] ± ${tolerance}.` };
    }
    if (check.kind === "visual-evidence") {
      const required = Array.isArray(check.requiredViews) ? check.requiredViews : [];
      const missing = required.filter((view) => !evidence.views.includes(view));
      const passed = evidence.cameraRestored && missing.length === 0;
      return { kind: check.kind, status: passed ? "passed" : "failed", detail: passed
        ? `Captured ${required.join(", ")} at this revision and restored the prior camera.`
        : `Missing views: ${missing.join(", ") || "none"}; camera restored: ${evidence.cameraRestored}.` };
    }
    return { kind: check.kind, status: "unsupported", detail: `Unsupported Fusion check kind: ${check.kind}.` };
  });
}

export function screenshotPayload(value: unknown): { mime: string; data: string } {
  if (isRecord(value)) {
    const data = string(value.base64Data, string(value.data, string(value.base64)));
    if (data) return { mime: string(value.mimeType, string(value.mime, "image/png")), data };
    for (const nested of Object.values(value)) {
      try {
        return screenshotPayload(nested);
      } catch {
        continue;
      }
    }
  }
  if (Array.isArray(value)) {
    for (const nested of value) {
      try {
        return screenshotPayload(nested);
      } catch {
        continue;
      }
    }
  }
  throw new Error("Fusion screenshot returned no image payload");
}

export interface CapturedFusionInspection {
  snapshot: FusionEngineeringSnapshotDto;
  revision: string;
  screenshots: FusionScreenshotDto[];
  cameraRestored: boolean;
}

export type CapturedFusionEngineeringState = Pick<CapturedFusionInspection, "snapshot" | "revision">;

export class FusionInspectionCaptureError extends Error {
  constructor(message: string, readonly cameraRestored: boolean, options?: ErrorOptions) {
    super(message, options);
  }
}

function inspectedDocument(value: unknown): FusionDocumentIdentityDto | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string") return undefined;
  return {
    id: value.id,
    name: value.name,
    ...(typeof value.dataFileId === "string" ? { dataFileId: value.dataFileId } : {}),
  };
}

function sameDocument(actual: FusionDocumentIdentityDto | undefined, expected: FusionDocumentIdentityDto): boolean {
  if (!actual) return false;
  return expected.dataFileId ? actual.dataFileId === expected.dataFileId : actual.id === expected.id;
}

async function requireBoundDocument(client: FusionMcpClient, expected: FusionDocumentIdentityDto): Promise<void> {
  const result = await executeFusionScript(client, inspectionDocumentIdentityScript());
  if (!sameDocument(inspectedDocument(result.document), expected)) {
    throw new Error("Fusion switched away from the bound Fusion document during evidence capture");
  }
}

export async function captureFusionInspection(
  client: FusionMcpClient,
  expectedDocument?: FusionDocumentIdentityDto,
  captureViews = false,
): Promise<CapturedFusionInspection> {
  const engineering = await captureFusionEngineeringState(client, expectedDocument);
  const snapshot = engineering.snapshot;
  // Rendering the multi-view sheet requires sweeping the live camera through each
  // orientation, which is exactly what makes the Fusion canvas flicker. Only pay
  // that cost - and only feed pixels to the model - when a caller actually wants a
  // visual read (a visual-evidence check). Routine scalar inspections and the
  // scalar verification after most actions stay camera-still and pixel-free: no
  // flicker, no wasted image budget. The camera never moves, so it is trivially
  // "restored".
  if (!captureViews) {
    return { snapshot, revision: engineering.revision, screenshots: [], cameraRestored: true };
  }
  const before = await executeFusionScript(client, captureInspectionCameraScript());
  if (!isRecord(before.camera)) throw new Error("Fusion camera inspector returned no camera state");
  const screenshots: FusionScreenshotDto[] = [];
  let sectionState: unknown;
  let captureFailure: unknown;
  try {
    for (const view of VIEWS) {
      if (expectedDocument) await requireBoundDocument(client, expectedDocument);
      if (view.view === "section") {
        sectionState = await executeFusionScript(client, showInspectionSectionScript(expectedDocument));
        if (!isRecord(sectionState) || sectionState.activated !== true) continue;
      }
      const payload = screenshotPayload(await client.callJson(READ_TOOL, {
        queryType: "screenshot",
        width: 1024,
        height: 1024,
        antiAliasing: true,
        transparentBackground: false,
        direction: view.direction,
      }));
      if (expectedDocument) await requireBoundDocument(client, expectedDocument);
      screenshots.push({ view: view.view, mime: payload.mime, dataUrl: `data:${payload.mime};base64,${payload.data}` });
    }
  } catch (error) {
    captureFailure = error;
  }
  if (sectionState) {
    try {
      await executeFusionScript(client, restoreInspectionSectionsScript(sectionState, expectedDocument));
    } catch (error) {
      captureFailure ??= error;
    }
  }
  if (!captureFailure) {
    try {
      const afterCapture = await captureFusionEngineeringState(client, expectedDocument);
      if (afterCapture.revision !== engineering.revision) {
        throw new Error("Fusion engineering revision changed during evidence capture");
      }
    } catch (error) {
      captureFailure = error;
    }
  }
  let cameraRestored = false;
  try {
    const restoration = await executeFusionScript(client, restoreInspectionCameraScript(before.camera, expectedDocument));
    if (restoration.restored === true) {
      const after = await executeFusionScript(client, captureInspectionCameraScript());
      cameraRestored = isRecord(after.camera) && stableJson(after.camera) === stableJson(before.camera);
    }
  } catch {
    cameraRestored = false;
  }
  if (captureFailure) {
    const message = captureFailure instanceof Error ? captureFailure.message : String(captureFailure);
    throw new FusionInspectionCaptureError(message, cameraRestored, { cause: captureFailure });
  }
  return { snapshot, revision: engineering.revision, screenshots, cameraRestored };
}

export async function captureFusionEngineeringState(
  client: FusionMcpClient,
  expectedDocument?: FusionDocumentIdentityDto,
): Promise<CapturedFusionEngineeringState> {
  const raw = await executeFusionScript(client, engineeringSnapshotScript());
  const actualDocument = inspectedDocument(raw.document);
  if (expectedDocument && !sameDocument(actualDocument, expectedDocument)) {
    throw new Error(`Fusion switched away from the bound Fusion document before inspection completed (expected ${expectedDocument.dataFileId ?? expectedDocument.id}, got ${actualDocument?.dataFileId ?? actualDocument?.id ?? "none"})`);
  }
  const snapshot = canonicalizeFusionSnapshot(raw.snapshot);
  return { snapshot, revision: fingerprintFusionSnapshot(snapshot) };
}
