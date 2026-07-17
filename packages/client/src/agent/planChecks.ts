import { Type, type Static } from "@earendil-works/pi-ai";
import { FusionExpectedEffectSchema, isFusionExpectedEffect } from "@chamfer/shared";

const positive = Type.Number({ exclusiveMinimum: 0 });
const nonNegative = Type.Number({ minimum: 0 });
const target = Type.Optional(Type.String({ minLength: 1 }));
// Stable identity within the component: spec-sheet refs and snapshot diffing
// match checks by this id, so it must survive plan revisions unchanged.
const checkId = Type.String({
  minLength: 1,
  description:
    'Stable short slug identifying this check within its component (e.g. "wall", "volume"); unique per component and kept identical across plan revisions.',
});
// Audit metadata for the check-monotonicity ratchet: tightening is free, any
// weakening carries a user-visible reason, and deletion leaves a tombstone.
const revisionReason = Type.Optional(
  Type.String({
    minLength: 1,
    description:
      "Why this check was weakened (or removed) relative to the previous plan snapshot. Required for any non-tightening edit; rendered to the user beside the check and kept in every later snapshot.",
  }),
);
const removed = Type.Optional(
  Type.Literal(true, {
    description:
      "Retires this check from the acceptance criteria while keeping it visible as an audit tombstone. Requires revision_reason; the entry must stay in every later snapshot.",
  }),
);
const refitToMeasurement = Type.Optional(
  Type.Literal(true, {
    description: "Permanent audit flag set when a revised range newly captures the latest measured value.",
  }),
);
// Fixed-length homogeneous arrays instead of Type.Tuple throughout this file:
// TypeBox tuples serialize to draft-07 syntax (items: [...] + additionalItems),
// which the Anthropic API rejects under its JSON Schema draft 2020-12 validation.
const fixedNumbers = (item: ReturnType<typeof Type.Number> | ReturnType<typeof Type.Integer>, length: number) =>
  Type.Array(item, { minItems: length, maxItems: length });
const count = Type.Union([
  Type.Integer({ minimum: 0 }),
  fixedNumbers(Type.Integer({ minimum: 0 }), 2),
]);

export const PLAN_CHECK_ENTRY_SCHEMA = Type.Union([
  Type.Object(
    {
      id: checkId,
      revision_reason: revisionReason,
      removed,
      refit_to_measurement: refitToMeasurement,
      kind: Type.Literal("fusion_effect"),
      effect: FusionExpectedEffectSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      id: checkId,
      revision_reason: revisionReason,
      removed,
      refit_to_measurement: refitToMeasurement,
      kind: Type.Union([Type.Literal("hole_through"), Type.Literal("hole_blind"), Type.Literal("hole_internal")]),
      diameter: positive,
      count: Type.Integer({ minimum: 0 }),
      at_mm: Type.Optional(fixedNumbers(Type.Number(), 3)),
      tol: Type.Optional(positive),
      target,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      id: checkId,
      revision_reason: revisionReason,
      removed,
      refit_to_measurement: refitToMeasurement,
      kind: Type.Literal("clearance"),
      a: Type.String({ minLength: 1 }),
      b: Type.String({ minLength: 1 }),
      min_mm: nonNegative,
      max_mm: Type.Optional(nonNegative),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      id: checkId,
      revision_reason: revisionReason,
      removed,
      refit_to_measurement: refitToMeasurement,
      kind: Type.Literal("bbox"),
      size_mm: fixedNumbers(positive, 3),
      tol: Type.Optional(positive),
      target,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      id: checkId,
      revision_reason: revisionReason,
      removed,
      refit_to_measurement: refitToMeasurement,
      kind: Type.Literal("volume"),
      range_mm3: fixedNumbers(Type.Number(), 2),
      target,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      id: checkId,
      revision_reason: revisionReason,
      removed,
      refit_to_measurement: refitToMeasurement,
      kind: Type.Literal("wall_thickness"),
      range_mm: fixedNumbers(positive, 2),
      target,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      id: checkId,
      revision_reason: revisionReason,
      removed,
      refit_to_measurement: refitToMeasurement,
      kind: Type.Union([Type.Literal("count_faces"), Type.Literal("count_edges")]),
      count,
      target,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      id: checkId,
      revision_reason: revisionReason,
      removed,
      refit_to_measurement: refitToMeasurement,
      kind: Type.Literal("symmetric"),
      plane: Type.Union([Type.Literal("XY"), Type.Literal("XZ"), Type.Literal("YZ")]),
      tol_pct: Type.Optional(positive),
      target,
    },
    { additionalProperties: false },
  ),
]);

export type PlanCheckEntry = Static<typeof PLAN_CHECK_ENTRY_SCHEMA>;

type WithoutCheckAudit<T> = T extends unknown
  ? Omit<T, "revision_reason" | "removed" | "refit_to_measurement">
  : never;
type DomainPlanCheckInput = WithoutCheckAudit<PlanCheckEntry>;
type DomainPlanCheckRevisionInput = DomainPlanCheckInput extends infer Check
  ? Check extends unknown ? Omit<Check, "id"> : never
  : never;

function checkSchemaWithout(properties: readonly string[]) {
  const schema = structuredClone(PLAN_CHECK_ENTRY_SCHEMA) as unknown as {
    anyOf: Array<{ properties: Record<string, unknown>; required?: string[] }>;
  };
  for (const variant of schema.anyOf) {
    for (const property of properties) delete variant.properties[property];
    if (Array.isArray(variant.required)) {
      variant.required = variant.required.filter((property) => !properties.includes(property));
    }
  }
  return schema as unknown as typeof PLAN_CHECK_ENTRY_SCHEMA;
}

/** New check definition. Audit flags and retirement metadata are reducer-owned. */
export const DOMAIN_PLAN_CHECK_INPUT_SCHEMA = Type.Unsafe<DomainPlanCheckInput>(
  checkSchemaWithout(["revision_reason", "removed", "refit_to_measurement"]),
);

/** Check replacement semantics. The reducer preserves the stable check id. */
export const DOMAIN_PLAN_CHECK_REVISION_INPUT_SCHEMA = Type.Unsafe<DomainPlanCheckRevisionInput>(
  checkSchemaWithout(["id", "revision_reason", "removed", "refit_to_measurement"]),
);

export const PLAN_CHECK_REF_SCHEMA = Type.Object(
  {
    component_id: Type.String({ minLength: 1 }),
    check_id: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

/**
 * Reference to a component check by its stable id. Snapshots persisted before
 * check ids existed carry `{component_id, check_index}` instead; they are
 * migrated by position when the next snapshot is validated, and the plan
 * artifact renders them by index as a fallback.
 */
export interface PlanCheckRef {
  component_id: string;
  check_id: string;
}

export const PLAN_SPEC_SHEET_ROW_SCHEMA = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    text: Type.String({ minLength: 1 }),
    source: Type.Union([Type.Literal("image"), Type.Literal("text")]),
    check_refs: Type.Optional(Type.Array(PLAN_CHECK_REF_SCHEMA)),
    unverifiable_reason: Type.Optional(Type.String()),
    revision_reason: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "Why this published row was repointed to different checks or downgraded to unverifiable. Required for those changes and kept in later snapshots.",
      }),
    ),
  },
  { additionalProperties: false },
);

export interface PlanSpecSheetRow {
  id: string;
  text: string;
  source: "image" | "text";
  check_refs?: PlanCheckRef[];
  unverifiable_reason?: string;
  revision_reason?: string;
}

const CHECK_KEYS: Record<string, { required: string[]; optional: string[] }> = {
  fusion_effect: { required: ["effect"], optional: [] },
  hole_through: { required: ["diameter", "count"], optional: ["at_mm", "tol", "target"] },
  hole_blind: { required: ["diameter", "count"], optional: ["at_mm", "tol", "target"] },
  hole_internal: { required: ["diameter", "count"], optional: ["at_mm", "tol", "target"] },
  clearance: { required: ["a", "b", "min_mm"], optional: ["max_mm"] },
  bbox: { required: ["size_mm"], optional: ["target", "tol"] },
  volume: { required: ["range_mm3"], optional: ["target"] },
  wall_thickness: { required: ["range_mm"], optional: ["target"] },
  count_faces: { required: ["count"], optional: ["target"] },
  count_edges: { required: ["count"], optional: ["target"] },
  symmetric: { required: ["plane"], optional: ["target", "tol_pct"] },
};

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validCount(value: unknown, allowRange: boolean): boolean {
  if (Number.isInteger(value) && (value as number) >= 0) return true;
  return Boolean(
    allowRange &&
      Array.isArray(value) &&
      value.length === 2 &&
      value.every((v) => Number.isInteger(v) && v >= 0) &&
      value[0] <= value[1],
  );
}

/** Stable check identity: same slug rules as component ids. */
export const CHECK_ID_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

/**
 * Keys that exist only on plan checks (identity and audit metadata); run CHECKS
 * entries never carry them, so they are stripped before any plan-to-run comparison.
 */
export const PLAN_CHECK_METADATA_KEYS: readonly string[] = [
  "id",
  "revision_reason",
  "removed",
  "refit_to_measurement",
  "retired_revision",
];

/**
 * Runtime mirror of the harness CHECKS contract plus the plan-only metadata
 * keys, with user-facing plan errors.
 */
export function validatePlanCheck(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["must be an object"];
  const check = value as Record<string, unknown>;
  const kind = check.kind;
  if (typeof kind !== "string" || !(kind in CHECK_KEYS)) return [`unknown check kind ${JSON.stringify(kind)}`];
  const contract = CHECK_KEYS[kind] as { required: string[]; optional: string[] };
  const keys = Object.keys(check).filter((key) => key !== "kind" && !PLAN_CHECK_METADATA_KEYS.includes(key));
  const missing = contract.required.filter((key) => !(key in check));
  const unknown = keys.filter((key) => !contract.required.includes(key) && !contract.optional.includes(key));
  const errors: string[] = [];
  if (typeof check.id !== "string" || !CHECK_ID_PATTERN.test(check.id)) {
    errors.push(`id must be a short slug matching ${CHECK_ID_PATTERN}, stable across plan revisions`);
  }
  if (check.revision_reason !== undefined && (typeof check.revision_reason !== "string" || check.revision_reason.trim() === "")) {
    errors.push("revision_reason must be a non-empty string when provided");
  }
  if (check.removed !== undefined && check.removed !== true) errors.push("removed must be true when provided");
  if (check.refit_to_measurement !== undefined && check.refit_to_measurement !== true) errors.push("refit_to_measurement must be true when provided");
  if (check.removed === true && (typeof check.revision_reason !== "string" || check.revision_reason.trim() === "")) {
    errors.push("removed checks require a non-empty revision_reason");
  }
  if (missing.length > 0) errors.push(`missing keys: ${JSON.stringify(missing)}`);
  if (unknown.length > 0) errors.push(`unknown keys: ${JSON.stringify(unknown)}`);
  if (missing.length > 0) return errors;

  if (kind === "fusion_effect") {
    if (!isFusionExpectedEffect(check.effect)) errors.push("effect must be a supported typed Fusion action effect");
  } else if (kind.startsWith("hole_")) {
    if (!isNumber(check.diameter) || check.diameter <= 0) errors.push("diameter must be a positive number");
    if (!validCount(check.count, false)) errors.push("count must be an integer >= 0");
    if (check.at_mm !== undefined && (!Array.isArray(check.at_mm) || check.at_mm.length !== 3 || check.at_mm.some((v) => !isNumber(v)))) errors.push("at_mm must be three numbers");
    if (check.tol !== undefined && (!isNumber(check.tol) || check.tol <= 0)) errors.push("tol must be positive");
  } else if (kind === "clearance") {
    if (typeof check.a !== "string" || !check.a || typeof check.b !== "string" || !check.b) errors.push("a and b must be non-empty strings");
    if (!isNumber(check.min_mm) || check.min_mm < 0) errors.push("min_mm must be a number >= 0");
    if (check.max_mm !== undefined && (!isNumber(check.max_mm) || !isNumber(check.min_mm) || check.max_mm < check.min_mm)) errors.push("max_mm must be a number >= min_mm");
  } else if (kind === "bbox") {
    if (!Array.isArray(check.size_mm) || check.size_mm.length !== 3 || check.size_mm.some((v) => !isNumber(v) || v <= 0)) errors.push("size_mm must be three positive numbers");
    if (check.tol !== undefined && (!isNumber(check.tol) || check.tol <= 0)) errors.push("tol must be positive");
  } else if (kind === "volume") {
    if (!Array.isArray(check.range_mm3) || check.range_mm3.length !== 2 || check.range_mm3.some((v) => !isNumber(v)) || (isNumber(check.range_mm3?.[0]) && isNumber(check.range_mm3?.[1]) && check.range_mm3[0] > check.range_mm3[1])) errors.push("range_mm3 must be [min, max] with min <= max");
  } else if (kind === "wall_thickness") {
    if (!Array.isArray(check.range_mm) || check.range_mm.length !== 2 || check.range_mm.some((v) => !isNumber(v) || v <= 0) || (isNumber(check.range_mm?.[0]) && isNumber(check.range_mm?.[1]) && check.range_mm[0] > check.range_mm[1])) errors.push("range_mm must be [min, max] with 0 < min <= max");
  } else if (kind === "count_faces" || kind === "count_edges") {
    if (!validCount(check.count, true)) errors.push("count must be an integer >= 0 or [min, max]");
  } else if (kind === "symmetric") {
    if (!new Set(["XY", "XZ", "YZ"]).has(check.plane as string)) errors.push("plane must be XY, XZ, or YZ");
    if (check.tol_pct !== undefined && (!isNumber(check.tol_pct) || check.tol_pct <= 0)) errors.push("tol_pct must be positive");
  }
  if (check.target !== undefined && (typeof check.target !== "string" || !check.target)) errors.push("target must be a non-empty string");
  return errors;
}

/** Runtime mirror for validating spec-sheet rows in stored legacy snapshots. */
export function validatePlanSpecSheetRow(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["must be an object"];
  const row = value as Record<string, unknown>;
  const errors: string[] = [];
  if (typeof row.id !== "string" || row.id.trim() === "") errors.push("id must be a non-empty string");
  if (typeof row.text !== "string" || row.text.trim() === "") errors.push("text must be a non-empty string");
  if (row.source !== "image" && row.source !== "text") errors.push('source must be "image" or "text"');
  if (row.check_refs !== undefined && !Array.isArray(row.check_refs)) {
    errors.push("check_refs must be an array");
  } else {
    for (const [index, valueRef] of ((row.check_refs as unknown[] | undefined) ?? []).entries()) {
      if (!valueRef || typeof valueRef !== "object" || Array.isArray(valueRef)) {
        errors.push(`check_refs[${index}] must be an object`);
        continue;
      }
      const ref = valueRef as Record<string, unknown>;
      if (typeof ref.component_id !== "string" || ref.component_id.trim() === "") {
        errors.push(`check_refs[${index}].component_id must be a non-empty string`);
      }
      if (typeof ref.check_id !== "string" || ref.check_id.trim() === "") {
        errors.push(`check_refs[${index}].check_id must be a non-empty string naming a component check id`);
      }
    }
  }
  if (row.unverifiable_reason !== undefined && typeof row.unverifiable_reason !== "string") {
    errors.push("unverifiable_reason must be a string");
  }
  if (
    row.revision_reason !== undefined &&
    (typeof row.revision_reason !== "string" || row.revision_reason.trim() === "")
  ) {
    errors.push("revision_reason must be a non-empty string when provided");
  }
  const hasChecks = Array.isArray(row.check_refs) && row.check_refs.length > 0;
  const hasReason = typeof row.unverifiable_reason === "string" && row.unverifiable_reason.trim() !== "";
  if (!hasChecks && !hasReason) {
    errors.push("provide non-empty check_refs or a non-empty unverifiable_reason");
  }
  return errors;
}
