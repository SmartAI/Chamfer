import type { DatabaseSync } from "node:sqlite";
import type {
  CreateReferenceRegistrationInput,
  ReferenceGeometryEvidence,
  ReferencePoint,
  ReferenceRegistrationDto,
  ReferenceSourceRegion,
} from "@chamfer/shared";
import { appendEvidenceEvent, projectEvidence } from "./evidenceStore";

interface RegistrationRow {
  event_id: string;
  registration_id: string;
  conversation_id: string;
  reference_id: string;
  revision: number;
  payload_json: string;
  eligibility_json: string;
  created_at: number;
}

export class ReferenceRegistrationError extends Error {
  constructor(message: string, readonly code: "invalid" | "conflict" = "invalid") {
    super(message);
  }
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function normalizedPoint(point: ReferencePoint | undefined): point is ReferencePoint {
  return Boolean(point) && finite(point?.x) && finite(point?.y) &&
    point!.x >= 0 && point!.x <= 1 && point!.y >= 0 && point!.y <= 1;
}

function normalizedRegion(region: ReferenceSourceRegion | undefined): region is ReferenceSourceRegion {
  return Boolean(region) && finite(region?.x) && finite(region?.y) &&
    finite(region?.width) && finite(region?.height) &&
    region!.x >= 0 && region!.y >= 0 && region!.width > 0 && region!.height > 0 &&
    region!.x + region!.width <= 1 + Number.EPSILON &&
    region!.y + region!.height <= 1 + Number.EPSILON;
}

function pointInRegion(point: ReferencePoint, region: ReferenceSourceRegion): boolean {
  return point.x >= region.x && point.x <= region.x + region.width &&
    point.y >= region.y && point.y <= region.y + region.height;
}

function expectedRegion(region: ReferenceSourceRegion, width: number, height: number) {
  const x = Math.floor(region.x * width);
  const y = Math.floor(region.y * height);
  const right = Math.ceil((region.x + region.width) * width);
  const bottom = Math.ceil((region.y + region.height) * height);
  return { x, y, width: right - x, height: bottom - y };
}

function close(left: number, right: number): boolean {
  return Math.abs(left - right) <= Math.max(1e-6, Math.abs(right) * 1e-6);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function validateGeometry(input: CreateReferenceRegistrationInput): void {
  const geometry = input.geometry;
  if (!geometry || !Number.isInteger(geometry.sourceSizePx?.width) || !Number.isInteger(geometry.sourceSizePx?.height) ||
      geometry.sourceSizePx.width <= 0 || geometry.sourceSizePx.height <= 0) {
    throw new ReferenceRegistrationError("source pixel dimensions are invalid");
  }
  const expected = expectedRegion(input.sourceRegion, geometry.sourceSizePx.width, geometry.sourceSizePx.height);
  if (!geometry.regionPx || expected.x !== geometry.regionPx.x || expected.y !== geometry.regionPx.y ||
      expected.width !== geometry.regionPx.width || expected.height !== geometry.regionPx.height) {
    throw new ReferenceRegistrationError("derived pixel region does not match the registered source region");
  }
  if (geometry.extraction?.extractor?.id !== "opencv-js-contour" ||
      geometry.extraction.extractor.version !== 1 ||
      !["succeeded", "failed"].includes(geometry.extraction.status)) {
    throw new ReferenceRegistrationError("geometry extraction metadata is invalid");
  }
  if (geometry.extraction.status === "succeeded") {
    if (!geometry.mask || geometry.mask.width !== expected.width || geometry.mask.height !== expected.height ||
        !Array.isArray(geometry.mask.rle) || geometry.mask.rle.some((run) => !Number.isInteger(run) || run < 0) ||
        geometry.mask.rle.reduce((sum, run) => sum + run, 0) !== expected.width * expected.height) {
      throw new ReferenceRegistrationError("extracted mask is invalid");
    }
    if (!geometry.contour || !finite(geometry.contour.areaPx2) || geometry.contour.areaPx2 <= 0 ||
        !Array.isArray(geometry.contour.points) || geometry.contour.points.length < 3 ||
        geometry.contour.points.some((point) => !Array.isArray(point) || point.length !== 2 ||
          !finite(point[0]) || !finite(point[1]) || point[0] < 0 || point[1] < 0 ||
          point[0] >= expected.width || point[1] >= expected.height)) {
      throw new ReferenceRegistrationError("extracted contour is invalid");
    }
  } else if (!geometry.extraction.reason?.trim()) {
    throw new ReferenceRegistrationError("failed extraction requires a reason");
  }
  validateScaleTransform(input, geometry);
}

function validateScaleTransform(input: CreateReferenceRegistrationInput, geometry: ReferenceGeometryEvidence): void {
  if (!input.scaleAnchor) {
    if (geometry.scaleTransform) throw new ReferenceRegistrationError("scale transform requires a scale anchor");
    return;
  }
  const anchor = input.scaleAnchor;
  if (!anchor.specificationId?.trim() || !normalizedPoint(anchor.start) || !normalizedPoint(anchor.end) ||
      !finite(anchor.physicalLengthMm) || anchor.physicalLengthMm <= 0) {
    throw new ReferenceRegistrationError("scale anchor is invalid");
  }
  const pixelLength = Math.hypot(
    (anchor.end.x - anchor.start.x) * geometry.sourceSizePx.width,
    (anchor.end.y - anchor.start.y) * geometry.sourceSizePx.height,
  );
  const transform = geometry.scaleTransform;
  if (!transform || transform.specificationId !== anchor.specificationId ||
      !close(transform.physicalLengthMm, anchor.physicalLengthMm) ||
      !close(transform.pixelLength, pixelLength) ||
      !close(transform.mmPerPixel, anchor.physicalLengthMm / pixelLength) || pixelLength <= 0) {
    throw new ReferenceRegistrationError("derived scale transform does not match the scale anchor");
  }
}

function numbersIn(text: string): number[] {
  return [...text.matchAll(/(?:^|[^a-z0-9])(-?\d+(?:\.\d+)?)/gi)]
    .map((match) => Number(match[1]))
    .filter(Number.isFinite);
}

function validateAndNormalize(
  db: DatabaseSync,
  conversationId: string,
  input: CreateReferenceRegistrationInput,
): CreateReferenceRegistrationInput {
  if (!input || typeof input !== "object" || !input.referenceId?.trim()) {
    throw new ReferenceRegistrationError("reference registration is required");
  }
  if (!normalizedRegion(input.sourceRegion)) throw new ReferenceRegistrationError("source region is invalid");
  if (!["orthographic", "perspective", "unknown"].includes(input.projection)) {
    throw new ReferenceRegistrationError("projection kind is invalid");
  }
  if (input.direction && !["front", "back", "left", "right", "top", "bottom"].includes(input.direction)) {
    throw new ReferenceRegistrationError("view direction is invalid");
  }
  if (!Array.isArray(input.visibleLandmarks) || input.visibleLandmarks.some((landmark) =>
    !landmark.id?.trim() || !landmark.label?.trim() || !normalizedPoint(landmark.position) ||
    !pointInRegion(landmark.position, input.sourceRegion)) ||
    new Set(input.visibleLandmarks.map((landmark) => landmark.id.trim())).size !== input.visibleLandmarks.length) {
    throw new ReferenceRegistrationError("visible landmarks are invalid");
  }
  if (!input.uncertainty || !["low", "medium", "high"].includes(input.uncertainty.level) ||
      typeof input.uncertainty.notes !== "string" || typeof input.uncertainty.occluded !== "boolean") {
    throw new ReferenceRegistrationError("uncertainty is invalid");
  }
  const projection = projectEvidence(db, conversationId);
  const reference = projection.referenceRecords.find((record) => record.referenceId === input.referenceId);
  if (!reference) throw new ReferenceRegistrationError(`reference ${input.referenceId} does not belong to this conversation`);
  if (reference.status !== "active" && reference.status !== "complementary") {
    throw new ReferenceRegistrationError(`reference ${input.referenceId} must be active or complementary before registration`);
  }
  if (input.scaleAnchor) {
    if (!normalizedPoint(input.scaleAnchor.start) || !normalizedPoint(input.scaleAnchor.end)) {
      throw new ReferenceRegistrationError("scale anchor is invalid");
    }
    if (!pointInRegion(input.scaleAnchor.start, input.sourceRegion) ||
        !pointInRegion(input.scaleAnchor.end, input.sourceRegion)) {
      throw new ReferenceRegistrationError("scale anchor must lie inside the registered source region");
    }
    const specification = projection.sourceSpecifications
      .find((candidate) => candidate.id === input.scaleAnchor!.specificationId);
    if (!specification) {
      throw new ReferenceRegistrationError(`scale specification ${input.scaleAnchor.specificationId} does not exist`);
    }
    if (specification.status !== "active") {
      throw new ReferenceRegistrationError(`scale specification ${specification.id} is superseded`);
    }
    if (!("attachmentId" in specification.source) || specification.source.attachmentId !== input.referenceId) {
      throw new ReferenceRegistrationError(`scale specification ${specification.id} is not sourced from reference ${input.referenceId}`);
    }
    if (!numbersIn(specification.requirement).some((value) => close(value, input.scaleAnchor!.physicalLengthMm))) {
      throw new ReferenceRegistrationError(`scale length is not supported by specification ${specification.id}`);
    }
  }
  validateGeometry(input);
  return {
    ...input,
    referenceId: input.referenceId.trim(),
    visibleLandmarks: input.visibleLandmarks.map((landmark) => ({
      ...landmark,
      id: landmark.id.trim(),
      label: landmark.label.trim(),
    })),
    uncertainty: { ...input.uncertainty, notes: input.uncertainty.notes.trim() },
  };
}

function eligibilityFor(input: CreateReferenceRegistrationInput): ReferenceRegistrationDto["eligibility"] {
  const reasons: string[] = [];
  if (input.projection === "perspective") reasons.push("Perspective projection cannot support physical shape proof.");
  if (input.projection === "unknown") reasons.push("Projection type is not established.");
  if (input.projection === "orthographic" && !input.direction) reasons.push("Orthographic view direction is not established.");
  if (!input.scaleAnchor || !input.geometry.scaleTransform) reasons.push("Physical scale is not established.");
  if (input.geometry.extraction.status === "failed") {
    reasons.push(`Object extraction failed: ${input.geometry.extraction.reason}.`);
  }
  if (input.uncertainty.occluded) reasons.push("The proof-bearing object is materially occluded.");
  if (input.uncertainty.level === "high") reasons.push("Registration uncertainty is high.");
  return { status: reasons.length === 0 ? "eligible" : "advisory", reasons };
}

function rows(db: DatabaseSync, conversationId: string): RegistrationRow[] {
  return db.prepare(`SELECT * FROM reference_registrations
    WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC`)
    .all(conversationId) as unknown as RegistrationRow[];
}

function toDtos(records: RegistrationRow[]): ReferenceRegistrationDto[] {
  const latestRevision = new Map<string, number>();
  for (const row of records) latestRevision.set(row.registration_id, Math.max(latestRevision.get(row.registration_id) ?? 0, row.revision));
  return records.map((row) => ({
    ...(JSON.parse(row.payload_json) as CreateReferenceRegistrationInput),
    registrationId: row.registration_id,
    conversationId: row.conversation_id,
    revision: row.revision,
    status: latestRevision.get(row.registration_id) === row.revision ? "current" : "stale",
    eligibility: JSON.parse(row.eligibility_json) as ReferenceRegistrationDto["eligibility"],
    timestamp: row.created_at,
  }));
}

export function listLegacyReferenceRegistrations(db: DatabaseSync, conversationId: string): ReferenceRegistrationDto[] {
  return toDtos(rows(db, conversationId));
}

export function listReferenceRegistrations(db: DatabaseSync, conversationId: string): ReferenceRegistrationDto[] {
  return projectEvidence(db, conversationId).referenceRegistrations;
}

export function registerReference(
  db: DatabaseSync,
  conversationId: string,
  submitted: CreateReferenceRegistrationInput,
  idempotencyKey?: string,
): ReferenceRegistrationDto {
  const input = validateAndNormalize(db, conversationId, submitted);
  const payloadJson = canonicalJson(input);
  const eventId = idempotencyKey?.trim() || crypto.randomUUID();
  const projection = projectEvidence(db, conversationId);
  const existingEvent = projection.events.find((event) => event.type === "reference.registered" &&
    event.data.commandIdempotencyKey === eventId);
  if (existingEvent) {
    if (existingEvent.type !== "reference.registered" || canonicalJson({
      ...existingEvent.data.registration,
      registrationId: undefined,
      conversationId: undefined,
      revision: undefined,
      status: undefined,
      eligibility: undefined,
      timestamp: undefined,
    }) !== payloadJson) {
      throw new ReferenceRegistrationError("idempotency key conflicts with an existing registration", "conflict");
    }
    return existingEvent.data.registration;
  }
  const current = projection.referenceRegistrations
    .filter((registration) => registration.referenceId === input.referenceId)
    .sort((left, right) => right.revision - left.revision)[0];
  if (current && canonicalJson({
    ...current,
    registrationId: undefined,
    conversationId: undefined,
    revision: undefined,
    status: undefined,
    eligibility: undefined,
    timestamp: undefined,
  }) === payloadJson) {
    return current;
  }
  const registrationId = current?.registrationId ?? crypto.randomUUID();
  const revision = (current?.revision ?? 0) + 1;
  const eligibility = eligibilityFor(input);
  const timestamp = Date.now();
  const registration: ReferenceRegistrationDto = {
    ...input,
    registrationId,
    conversationId,
    revision,
    status: "current",
    eligibility,
    timestamp,
  };
  appendEvidenceEvent(db, conversationId, {
    id: `${conversationId}:reference-registration:${registration.registrationId}:${registration.revision}`,
    type: "reference.registered",
    data: { registration, commandIdempotencyKey: eventId },
  });
  return registration;
}
