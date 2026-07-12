import { Type, type Static } from "@earendil-works/pi-ai";

const positive = Type.Number({ exclusiveMinimum: 0 });
const nonNegative = Type.Number({ minimum: 0 });
const target = Type.Optional(Type.String({ minLength: 1 }));
const count = Type.Union([
  Type.Integer({ minimum: 0 }),
  Type.Tuple([Type.Integer({ minimum: 0 }), Type.Integer({ minimum: 0 })]),
]);

export const PLAN_CHECK_ENTRY_SCHEMA = Type.Union([
  Type.Object(
    {
      kind: Type.Union([Type.Literal("hole_through"), Type.Literal("hole_blind"), Type.Literal("hole_internal")]),
      diameter: positive,
      count: Type.Integer({ minimum: 0 }),
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
      size_mm: Type.Tuple([positive, positive, positive]),
      tol: Type.Optional(positive),
      target,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("volume"),
      range_mm3: Type.Tuple([Type.Number(), Type.Number()]),
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
    },
    { additionalProperties: false },
  ),
]);

export type PlanCheckEntry = Static<typeof PLAN_CHECK_ENTRY_SCHEMA>;

const CHECK_KEYS: Record<string, { required: string[]; optional: string[] }> = {
  hole_through: { required: ["diameter", "count"], optional: ["tol", "target"] },
  hole_blind: { required: ["diameter", "count"], optional: ["tol", "target"] },
  hole_internal: { required: ["diameter", "count"], optional: ["tol", "target"] },
  clearance: { required: ["a", "b", "min_mm"], optional: ["max_mm"] },
  bbox: { required: ["size_mm"], optional: ["target", "tol"] },
  volume: { required: ["range_mm3"], optional: ["target"] },
  count_faces: { required: ["count"], optional: ["target"] },
  count_edges: { required: ["count"], optional: ["target"] },
  symmetric: { required: ["plane"], optional: ["tol_pct"] },
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
  } else if (kind === "count_faces" || kind === "count_edges") {
    if (!validCount(check.count, true)) errors.push("count must be an integer >= 0 or [min, max]");
  } else if (kind === "symmetric") {
    if (!new Set(["XY", "XZ", "YZ"]).has(check.plane as string)) errors.push("plane must be XY, XZ, or YZ");
    if (check.tol_pct !== undefined && (!isNumber(check.tol_pct) || check.tol_pct <= 0)) errors.push("tol_pct must be positive");
  }
  if (check.target !== undefined && (typeof check.target !== "string" || !check.target)) errors.push("target must be a non-empty string");
  return errors;
}
