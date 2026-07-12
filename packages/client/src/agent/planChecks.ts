import { Type, type Static } from "@earendil-works/pi-ai";

const positive = Type.Number({ exclusiveMinimum: 0 });
const nonNegative = Type.Number({ minimum: 0 });
const target = Type.Optional(Type.String({ minLength: 1 }));
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
      kind: Type.Literal("bbox"),
      size_mm: fixedNumbers(positive, 3),
      tol: Type.Optional(positive),
      target,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("volume"),
      range_mm3: fixedNumbers(Type.Number(), 2),
      target,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("wall_thickness"),
      range_mm: fixedNumbers(positive, 2),
      target,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Union([Type.Literal("count_faces"), Type.Literal("count_edges")]), count, target },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("symmetric"),
      plane: Type.Union([Type.Literal("XY"), Type.Literal("XZ"), Type.Literal("YZ")]),
      tol_pct: Type.Optional(positive),
      target,
    },
    { additionalProperties: false },
  ),
]);

export type PlanCheckEntry = Static<typeof PLAN_CHECK_ENTRY_SCHEMA>;

export const PLAN_CHECK_REF_SCHEMA = Type.Object(
  {
    component_id: Type.String({ minLength: 1 }),
    check_index: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export interface PlanCheckRef {
  component_id: string;
  check_index: number;
}

export const PLAN_SPEC_SHEET_ROW_SCHEMA = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    text: Type.String({ minLength: 1 }),
    source: Type.Union([Type.Literal("image"), Type.Literal("text")]),
    check_refs: Type.Optional(Type.Array(PLAN_CHECK_REF_SCHEMA)),
    unverifiable_reason: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export interface PlanSpecSheetRow {
  id: string;
  text: string;
  source: "image" | "text";
  check_refs?: PlanCheckRef[];
  unverifiable_reason?: string;
}

const CHECK_KEYS: Record<string, { required: string[]; optional: string[] }> = {
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

/** Runtime mirror of the harness CHECKS contract, with user-facing plan errors. */
export function validatePlanCheck(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["must be an object"];
  const check = value as Record<string, unknown>;
  const kind = check.kind;
  if (typeof kind !== "string" || !(kind in CHECK_KEYS)) return [`unknown check kind ${JSON.stringify(kind)}`];
  const contract = CHECK_KEYS[kind] as { required: string[]; optional: string[] };
  const keys = Object.keys(check).filter((key) => key !== "kind");
  const missing = contract.required.filter((key) => !(key in check));
  const unknown = keys.filter((key) => !contract.required.includes(key) && !contract.optional.includes(key));
  const errors: string[] = [];
  if (missing.length > 0) errors.push(`missing keys: ${JSON.stringify(missing)}`);
  if (unknown.length > 0) errors.push(`unknown keys: ${JSON.stringify(unknown)}`);
  if (missing.length > 0) return errors;

  if (kind.startsWith("hole_")) {
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

/** Runtime mirror for spec-sheet rows so update_plan can return row-level errors. */
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
      if (!Number.isInteger(ref.check_index) || (ref.check_index as number) < 0) {
        errors.push(`check_refs[${index}].check_index must be an integer >= 0`);
      }
    }
  }
  if (row.unverifiable_reason !== undefined && typeof row.unverifiable_reason !== "string") {
    errors.push("unverifiable_reason must be a string");
  }
  const hasChecks = Array.isArray(row.check_refs) && row.check_refs.length > 0;
  const hasReason = typeof row.unverifiable_reason === "string" && row.unverifiable_reason.trim() !== "";
  if (!hasChecks && !hasReason) {
    errors.push("provide non-empty check_refs or a non-empty unverifiable_reason");
  }
  return errors;
}
