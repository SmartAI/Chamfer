export const LOOP_OWNED_CHECK_POLICY = {
  version: 1,
  defaultToleranceMm: 0.5,
  defaultSymmetryTolerancePct: 1,
  maxChecks: 32,
  fusionRevisionRule: "equal-or-added-only",
} as const;

export type CheckComparatorVerdict = "tighten" | "equal" | "loosen";

export interface FrozenVerificationCheck {
  id: string;
  componentId: string;
  kind: string;
  criterion: Record<string, unknown>;
}

export interface FrozenVerificationCheckSet {
  contractId: string;
  revision: number;
  checks: FrozenVerificationCheck[];
}

export function frozenCheckSetFromContract(contract: {
  contractId: string;
  revision: number;
  derivation: { plannedChecks: readonly FrozenVerificationCheck[] };
}): FrozenVerificationCheckSet {
  return {
    contractId: contract.contractId,
    revision: contract.revision,
    checks: contract.derivation.plannedChecks.map((check) => ({ ...check })),
  };
}

export interface CheckComparison {
  checkId: string;
  componentId: string;
  verdict: CheckComparatorVerdict;
  reasons: string[];
  before?: FrozenVerificationCheck;
  after?: FrozenVerificationCheck;
}

export interface CheckSetComparison {
  verdict: CheckComparatorVerdict;
  checks: CheckComparison[];
}

export type VerificationCheckRevisionGate =
  | { passed: true; verdict: "tighten" | "equal" }
  | { passed: true; verdict: "loosen"; authorizedByEscalationId: string }
  | { passed: false; verdict: "loosen"; reason: string };

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function number(value: unknown, fallback?: number): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function interval(value: unknown): [number, number] | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return [value, value];
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const lower = number(value[0]);
  const upper = number(value[1]);
  return lower === undefined || upper === undefined ? undefined : [lower, upper];
}

function relation(
  previous: [number, number],
  next: [number, number],
): CheckComparatorVerdict {
  if (next[0] < previous[0] || next[1] > previous[1]) return "loosen";
  return next[0] === previous[0] && next[1] === previous[1] ? "equal" : "tighten";
}

function mergeVerdicts(verdicts: readonly CheckComparatorVerdict[]): CheckComparatorVerdict {
  if (verdicts.includes("loosen")) return "loosen";
  return verdicts.includes("tighten") ? "tighten" : "equal";
}

function exactFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  fields: readonly string[],
  reasons: string[],
): CheckComparatorVerdict[] {
  return fields.map((field) => {
    if (same(before[field], after[field])) return "equal";
    reasons.push(`${field} changed`);
    return "loosen";
  });
}

function intervalField(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  field: string,
  reasons: string[],
): CheckComparatorVerdict {
  const prior = interval(before[field]);
  const next = interval(after[field]);
  if (!prior || !next) {
    reasons.push(`${field} is not a comparable interval`);
    return "loosen";
  }
  const verdict = relation(prior, next);
  if (verdict === "loosen") reasons.push(`${field} widened`);
  return verdict;
}

function centeredInterval(value: unknown, tolerance: unknown, fallback: number): [number, number] | undefined {
  const center = number(value);
  const radius = number(tolerance, fallback);
  return center === undefined || radius === undefined ? undefined : [center - radius, center + radius];
}

function centeredField(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  valueField: string,
  toleranceField: string,
  fallback: number,
  reasons: string[],
): CheckComparatorVerdict {
  const prior = centeredInterval(before[valueField], before[toleranceField], fallback);
  const next = centeredInterval(after[valueField], after[toleranceField], fallback);
  if (!prior || !next) {
    reasons.push(`${valueField} and ${toleranceField} are not comparable`);
    return "loosen";
  }
  const verdict = relation(prior, next);
  if (verdict === "loosen") reasons.push(`${valueField} tolerance interval widened or moved outside the frozen interval`);
  return verdict;
}

function compareCriteria(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  reasons: string[],
): CheckComparatorVerdict {
  if (before.kind !== after.kind) {
    reasons.push(`kind changed from ${String(before.kind)} to ${String(after.kind)}`);
    return "loosen";
  }
  const kind = String(before.kind);
  if (kind === "fusion_effect") {
    if (same(before.effect, after.effect)) return "equal";
    reasons.push("frozen Fusion expected effect changed");
    return "loosen";
  }
  if (kind === "volume" || kind === "wall_thickness") {
    const field = kind === "volume" ? "range_mm3" : "range_mm";
    return mergeVerdicts([
      ...exactFields(before, after, ["target"], reasons),
      intervalField(before, after, field, reasons),
    ]);
  }
  if (kind === "count_faces" || kind === "count_edges") {
    return mergeVerdicts([
      ...exactFields(before, after, ["target"], reasons),
      intervalField(before, after, "count", reasons),
    ]);
  }
  if (kind === "clearance") {
    const prior: [number, number] = [number(before.min_mm, 0)!, number(before.max_mm, Infinity)!];
    const next: [number, number] = [number(after.min_mm, 0)!, number(after.max_mm, Infinity)!];
    const intervalVerdict = relation(prior, next);
    if (intervalVerdict === "loosen") reasons.push("clearance interval widened");
    return mergeVerdicts([...exactFields(before, after, ["a", "b"], reasons), intervalVerdict]);
  }
  if (kind === "bbox") {
    const priorSizes = Array.isArray(before.size_mm) ? [...before.size_mm].sort((a, b) => Number(a) - Number(b)) : [];
    const nextSizes = Array.isArray(after.size_mm) ? [...after.size_mm].sort((a, b) => Number(a) - Number(b)) : [];
    if (priorSizes.length !== 3 || nextSizes.length !== 3) {
      reasons.push("size_mm is not comparable");
      return "loosen";
    }
    const verdicts = priorSizes.map((size, index) => centeredField(
      { size, tol: before.tol },
      { size: nextSizes[index], tol: after.tol },
      "size",
      "tol",
      LOOP_OWNED_CHECK_POLICY.defaultToleranceMm,
      reasons,
    ));
    return mergeVerdicts([...exactFields(before, after, ["target"], reasons), ...verdicts]);
  }
  if (kind === "hole_through" || kind === "hole_blind" || kind === "hole_internal") {
    return mergeVerdicts([
      ...exactFields(before, after, ["count", "target", "at_mm"], reasons),
      centeredField(
        before,
        after,
        "diameter",
        "tol",
        LOOP_OWNED_CHECK_POLICY.defaultToleranceMm,
        reasons,
      ),
    ]);
  }
  if (kind === "symmetric") {
    const prior = number(before.tol_pct, LOOP_OWNED_CHECK_POLICY.defaultSymmetryTolerancePct)!;
    const next = number(after.tol_pct, LOOP_OWNED_CHECK_POLICY.defaultSymmetryTolerancePct)!;
    const toleranceVerdict = next > prior ? "loosen" : next < prior ? "tighten" : "equal";
    if (toleranceVerdict === "loosen") reasons.push("tol_pct increased");
    return mergeVerdicts([...exactFields(before, after, ["plane", "target"], reasons), toleranceVerdict]);
  }
  if (same(before, after)) return "equal";
  reasons.push(`unsupported check kind ${kind} changed`);
  return "loosen";
}

export function compareVerificationCheck(
  before: FrozenVerificationCheck,
  after: FrozenVerificationCheck,
): CheckComparison {
  const reasons: string[] = [];
  let verdict: CheckComparatorVerdict;
  if (before.id !== after.id || before.componentId !== after.componentId) {
    reasons.push("stable check identity changed");
    verdict = "loosen";
  } else if (before.kind !== after.kind || before.kind !== before.criterion.kind || after.kind !== after.criterion.kind) {
    reasons.push("check kind or criterion kind changed");
    verdict = "loosen";
  } else {
    verdict = compareCriteria(before.criterion, after.criterion, reasons);
  }
  return { checkId: before.id, componentId: before.componentId, verdict, reasons, before, after };
}

export function compareCheckSets(
  before: readonly FrozenVerificationCheck[],
  after: readonly FrozenVerificationCheck[],
): CheckSetComparison {
  const key = (check: FrozenVerificationCheck) => `${check.componentId}\0${check.id}`;
  const prior = new Map(before.map((check) => [key(check), check]));
  const next = new Map(after.map((check) => [key(check), check]));
  const checks: CheckComparison[] = [];
  for (const check of before) {
    const replacement = next.get(key(check));
    if (replacement) checks.push(compareVerificationCheck(check, replacement));
    else checks.push({
      checkId: check.id,
      componentId: check.componentId,
      verdict: "loosen",
      reasons: ["frozen check was removed"],
      before: check,
    });
  }
  for (const check of after) {
    if (prior.has(key(check))) continue;
    checks.push({
      checkId: check.id,
      componentId: check.componentId,
      verdict: "tighten",
      reasons: ["check was added"],
      after: check,
    });
  }
  return { verdict: mergeVerdicts(checks.map((check) => check.verdict)), checks };
}

export function verificationCheckRevisionGate(
  before: readonly FrozenVerificationCheck[],
  after: readonly FrozenVerificationCheck[],
  authorizedByEscalationId?: string,
): VerificationCheckRevisionGate {
  const comparison = compareCheckSets(before, after);
  if (comparison.verdict !== "loosen") return { passed: true, verdict: comparison.verdict };
  if (authorizedByEscalationId) {
    return { passed: true, verdict: "loosen", authorizedByEscalationId };
  }
  const reason = comparison.checks
    .filter((check) => check.verdict === "loosen")
    .flatMap((check) => check.reasons.map((item) => `${check.componentId}.${check.checkId}: ${item}`))
    .join("; ");
  return { passed: false, verdict: "loosen", reason };
}
import { canonicalJson } from "./canonicalJson";
