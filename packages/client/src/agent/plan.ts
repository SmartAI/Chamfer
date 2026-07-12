import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  PLAN_CHECK_METADATA_KEYS,
  validatePlanCheck,
  validatePlanSpecSheetRow,
  type PlanCheckEntry,
  type PlanSpecSheetRow,
} from "./planChecks";
import { validateSpecSheetRevision } from "./specSheetRevision";

export { parseComponentDeclaration } from "./componentDeclaration";
export type { PlanCheckEntry, PlanCheckRef, PlanSpecSheetRow } from "./planChecks";

/**
 * The plan artifact: a persisted, loop-enforced component list for multi-part designs.
 *
 * Snapshots are full replacements (never deltas) submitted through the update_plan
 * tool. An accepted snapshot lives in that tool result's `details.plan`; the transcript
 * is the storage (tool results are persisted and replayed like every other message),
 * so the latest accepted snapshot is derived by scanning the message history. The
 * trust model mirrors CHECKS: the agent authors the plan but cannot lie about
 * progress - `done` requires gate evidence, and removing unfinished work requires an
 * explicit abandon reason.
 */

export type PlanComponentStatus = "todo" | "building" | "done" | "blocked" | "abandoned";

export const FORM_REVIEW_VIEWS = ["isometric", "front", "back", "left", "right", "top", "bottom"] as const;
export type FormReviewView = (typeof FORM_REVIEW_VIEWS)[number];
export type FormReviewVerdict = "match" | "mismatch";

export interface FormReviewEntry {
  view: FormReviewView;
  verdict: FormReviewVerdict;
  note: string;
}

export interface FormReview {
  /** Tool-call id of the newest gate-passed run inspected by this review. */
  evidence_id: string;
  views: FormReviewEntry[];
}

export const PLAN_COMPONENT_STATUSES: readonly PlanComponentStatus[] = [
  "todo",
  "building",
  "done",
  "blocked",
  "abandoned",
];

export interface PlanComponent {
  /** Stable slug; must equal the Compound child label and the script COMPONENT declaration. */
  id: string;
  description: string;
  /** Target envelope, sorted-compare semantics like EXPECT.bbox_mm. */
  bbox_mm?: number[];
  /** CHECKS entries scoped to this component; the gate evidence for `done` must include them. */
  checks?: PlanCheckEntry[];
  status: PlanComponentStatus;
  /** Required when status is "abandoned"; surfaced in the UI and the final summary. */
  abandon_reason?: string;
  /** Required when status is "blocked"; states the limitation that prevented completion. */
  blocked_reason?: string;
  /** Exempts the component from interface coverage; must say why it is legitimately unattached. */
  free_floating_reason?: string;
  /** Required on an image-plan transition to done. */
  form_review?: FormReview;
}

export type PlanInterfaceKind = "clearance" | "captive";

export const PLAN_INTERFACE_KINDS: readonly PlanInterfaceKind[] = ["clearance", "captive"];

/**
 * A physical relation between two components. `clearance` bounds the gap (min_mm 0 =
 * contact allowed; max_mm 0 = touching required); `captive` declares retention without
 * contact (e.g. a hinge pin inside bores) and carries no dimensions.
 */
export interface PlanInterface {
  a: string;
  b: string;
  kind: PlanInterfaceKind;
  min_mm?: number;
  max_mm?: number;
}

export interface Plan {
  goal: string;
  components: PlanComponent[];
  interfaces: PlanInterface[];
  /** Required for image-triggered plans; optional but validated when present otherwise. */
  spec_sheet?: PlanSpecSheetRow[];
}

/** Component ids must be label-safe slugs; "probe" is reserved for diagnostic runs. */
const COMPONENT_ID_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
export const PROBE_COMPONENT = "probe";

/** A component's required volume check may span at most this hi/lo ratio; looser
 * ranges cannot distinguish right topology from wrong (Phase 0's 200k-500k EXPECT
 * happily contained both the open and the sealed housing). */
export const VOLUME_RANGE_MAX_RATIO = 1.5;

export const UPDATE_PLAN_TOOL_NAME = "update_plan";

interface ToolResultLike {
  role?: unknown;
  toolName?: unknown;
  toolCallId?: unknown;
  isError?: unknown;
  details?: {
    plan?: unknown;
    gate?: { status?: unknown };
    measurements?: { component?: unknown; checks?: unknown };
  };
}

/** The newest accepted plan snapshot in the transcript, or undefined. */
export function latestPlan(messages: readonly unknown[]): Plan | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const m = messages[index] as ToolResultLike;
    if (m?.role !== "toolResult" || m.toolName !== UPDATE_PLAN_TOOL_NAME) continue;
    if (m.isError) continue;
    const plan = m.details?.plan;
    if (plan && typeof plan === "object") return plan as Plan;
  }
  return undefined;
}

/** True when the plan still has components to build (todo or building). */
export function planIncompleteComponents(plan: Plan): PlanComponent[] {
  return plan.components.filter((c) => c.status === "todo" || c.status === "building");
}

/**
 * The CHECKS entry a clearance interface compiles to, in both endpoint orders
 * (clearance is symmetric, so either ordering in the script is legitimate).
 * Captive interfaces have no measurable gate check and compile to nothing.
 */
function interfaceCheckForms(iface: PlanInterface): string[] {
  if (iface.kind !== "clearance") return [];
  const base: Record<string, unknown> = { kind: "clearance", min_mm: iface.min_mm };
  if (iface.max_mm !== undefined) base.max_mm = iface.max_mm;
  return [canonical({ ...base, a: iface.a, b: iface.b }), canonical({ ...base, a: iface.b, b: iface.a })];
}

/**
 * Whether some gate-passed run measured the assembly: it must declare every
 * non-abandoned component at once AND its echoed CHECKS must contain each
 * clearance interface's check entry - declaring the components without running
 * the interface checks proves nothing about the fit. Per-component "done"
 * statuses cannot certify the interfaces (Phase 6 live run: both components
 * were done while nothing had verified the lid actually rests on the flange),
 * so a plan with interfaces only counts as finished once this evidence exists.
 */
export function hasAssemblyEvidence(plan: Plan, messages: readonly unknown[]): boolean {
  const active = new Set(
    plan.components.filter((c) => c.status !== "abandoned" && c.status !== "blocked").map((c) => c.id),
  );
  const interfaces = (plan.interfaces ?? []).filter((i) => active.has(i.a) && active.has(i.b));
  if (active.size < 2 || interfaces.length === 0) return true;
  for (const message of messages) {
    const m = message as ToolResultLike;
    if (m?.role !== "toolResult" || m.toolName !== "run_build123d" || m.isError) continue;
    if (m.details?.gate?.status !== "passed") continue;
    const measurements = m.details?.measurements;
    const ids = new Set(runComponentIds(measurements));
    if (![...active].every((id) => ids.has(id))) continue;
    const rawChecks = Array.isArray(measurements?.checks) ? (measurements?.checks as unknown[]) : [];
    const ran = new Set(rawChecks.map(canonical));
    const allInterfacesRan = interfaces.every((iface) => {
      const forms = interfaceCheckForms(iface);
      // Captive interfaces compile to no measurable check; the all-components
      // gate-passed run itself is the best available evidence for them.
      return forms.length === 0 || forms.some((form) => ran.has(form));
    });
    if (allInterfacesRan) return true;
  }
  return false;
}

/** Component ids a run declared, normalized to an array; [] when undeclared or malformed. */
export function runComponentIds(measurements: { component?: unknown } | undefined): string[] {
  const declared = measurements?.component;
  if (typeof declared === "string") return [declared];
  if (Array.isArray(declared)) return declared.filter((id): id is string => typeof id === "string");
  return [];
}

/**
 * The harness-shaped projection of a plan check: the entry as a run's CHECKS
 * block would carry it, with the plan-only metadata keys (id, audit fields)
 * stripped. Every plan-to-run comparison must go through this projection.
 */
export function harnessCheckForm(check: PlanCheckEntry): Record<string, unknown> {
  const form: Record<string, unknown> = { ...(check as Record<string, unknown>) };
  for (const key of PLAN_CHECK_METADATA_KEYS) delete form[key];
  return form;
}

/** Canonical JSON (sorted keys) so check-entry membership survives key ordering. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.keys(value as object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

export interface ComponentEvidence {
  /** Canonical forms of the CHECKS entries run alongside the newest gate-passed run declaring the component. */
  checks: Set<string>;
  /** Tool-call id of this newest gate-passed run. */
  evidenceId?: string;
}

/**
 * Gate evidence per component id, derived from the transcript: the newest gate-passed
 * run_build123d result that declared the component (COMPONENT echo in measurements),
 * with the raw CHECKS entries the harness echoed for that run. Probe declarations
 * never produce evidence. Deterministic over the message array, so a reloaded
 * conversation reconstructs the same evidence.
 */
export function collectComponentEvidence(messages: readonly unknown[]): Map<string, ComponentEvidence> {
  const evidence = new Map<string, ComponentEvidence>();
  for (const message of messages) {
    const m = message as ToolResultLike;
    if (m?.role !== "toolResult" || m.toolName !== "run_build123d" || m.isError) continue;
    if (m.details?.gate?.status !== "passed") continue;
    const measurements = m.details?.measurements;
    const ids = runComponentIds(measurements).filter((id) => id !== PROBE_COMPONENT);
    if (ids.length === 0) continue;
    const rawChecks = Array.isArray(measurements?.checks) ? (measurements?.checks as unknown[]) : [];
    const checks = new Set(rawChecks.map(canonical));
    const evidenceId = typeof m.toolCallId === "string" ? m.toolCallId : undefined;
    for (const id of ids) evidence.set(id, { checks, evidenceId });
  }
  return evidence;
}

export interface ValidatePlanArgs {
  next: Plan;
  previous: Plan | undefined;
  evidence: Map<string, ComponentEvidence>;
  requireSpecSheet?: boolean;
}

export interface AcceptedCheckRevision {
  componentId: string;
  checkId: string;
  reason: string;
}

const DEFAULT_TOLERANCE = 0.5;

function sameValue(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

function intervalWeakening(next: unknown, previous: unknown, key: string): string | undefined {
  if (!Array.isArray(next) || !Array.isArray(previous) || next.length !== 2 || previous.length !== 2) return undefined;
  if (next[0] >= previous[0] && next[1] <= previous[1]) return undefined;
  return `${key} [${next.join(", ")}] is not within the previous [${previous.join(", ")}]`;
}

function checkWeakeningReasons(next: PlanCheckEntry, previous: PlanCheckEntry): string[] {
  const current = next as Record<string, unknown>;
  const prior = previous as Record<string, unknown>;
  if (current.removed === true) return prior.removed === true ? [] : ["was removed"];
  if (prior.removed === true) return [];

  const reasons: string[] = [];
  if (current.kind !== prior.kind) reasons.push(`kind changed from ${JSON.stringify(prior.kind)} to ${JSON.stringify(current.kind)}`);
  if (!sameValue(current.target, prior.target)) reasons.push(`target changed from ${JSON.stringify(prior.target)} to ${JSON.stringify(current.target)}`);
  if (current.kind !== prior.kind) return reasons;

  const intervalKey = current.kind === "volume" ? "range_mm3" : current.kind === "wall_thickness" ? "range_mm" : undefined;
  if (intervalKey) {
    const reason = intervalWeakening(current[intervalKey], prior[intervalKey], intervalKey);
    if (reason) reasons.push(reason);
  }
  for (const toleranceKey of ["tol", "tol_pct"] as const) {
    const oldTolerance = typeof prior[toleranceKey] === "number" ? prior[toleranceKey] : DEFAULT_TOLERANCE;
    const newTolerance = typeof current[toleranceKey] === "number" ? current[toleranceKey] : DEFAULT_TOLERANCE;
    if (newTolerance > oldTolerance) reasons.push(`${toleranceKey} raised from ${oldTolerance} to ${newTolerance}`);
  }

  const freelyComparable = new Set(["id", "revision_reason", "removed", "kind", "target", "range_mm3", "range_mm", "tol", "tol_pct"]);
  for (const key of new Set([...Object.keys(prior), ...Object.keys(current)])) {
    if (freelyComparable.has(key)) continue;
    let before = prior[key];
    let after = current[key];
    if (key === "size_mm" && Array.isArray(before) && Array.isArray(after)) {
      before = [...before].sort((a, b) => Number(a) - Number(b));
      after = [...after].sort((a, b) => Number(a) - Number(b));
    }
    if (!sameValue(after, before)) reasons.push(`${key} changed from ${JSON.stringify(prior[key])} to ${JSON.stringify(current[key])}`);
  }
  return reasons;
}

function pairedPreviousChecks(nextChecks: PlanCheckEntry[], previousChecks: PlanCheckEntry[]): Map<PlanCheckEntry, PlanCheckEntry> {
  const pairs = new Map<PlanCheckEntry, PlanCheckEntry>();
  const unused = new Set(nextChecks);
  for (const previous of previousChecks) {
    const previousId = (previous as { id?: unknown }).id;
    let next = typeof previousId === "string" ? nextChecks.find((check) => check.id === previousId) : undefined;
    if (!next && typeof previousId !== "string") {
      next = nextChecks.find((check) => unused.has(check) && sameValue(harnessCheckForm(check), harnessCheckForm(previous)));
    }
    if (!next && typeof previousId !== "string") next = nextChecks[previousChecks.indexOf(previous)];
    if (next) {
      pairs.set(previous, next);
      unused.delete(next);
    }
  }
  return pairs;
}

export function acceptedCheckRevisions(next: Plan, previous: Plan | undefined): AcceptedCheckRevision[] {
  if (!previous) return [];
  const revisions: AcceptedCheckRevision[] = [];
  for (const component of next.components) {
    if (component.status === "abandoned") continue;
    const oldComponent = previous.components.find((candidate) => candidate.id === component.id);
    if (!oldComponent) continue;
    const pairs = pairedPreviousChecks(component.checks ?? [], oldComponent.checks ?? []);
    for (const [oldCheck, newCheck] of pairs) {
      if (checkWeakeningReasons(newCheck, oldCheck).length === 0) continue;
      const reason = newCheck.revision_reason?.trim();
      if (reason) revisions.push({ componentId: component.id, checkId: newCheck.id, reason });
    }
  }
  return revisions;
}

function validateCheckMonotonicity(next: Plan, previous: Plan): string[] {
  const errors: string[] = [];
  for (const component of next.components) {
    if (component.status === "abandoned") continue;
    const oldComponent = previous.components.find((candidate) => candidate.id === component.id);
    if (!oldComponent) continue;
    const pairs = pairedPreviousChecks(component.checks ?? [], oldComponent.checks ?? []);
    for (const oldCheck of oldComponent.checks ?? []) {
      const newCheck = pairs.get(oldCheck);
      const id = (oldCheck as { id?: string }).id ?? newCheck?.id ?? String((oldComponent.checks ?? []).indexOf(oldCheck));
      if (!newCheck) {
        errors.push(`component "${component.id}": check "${id}" was deleted without a trace; keep it with "removed": true and a non-empty revision_reason`);
        continue;
      }
      if (oldCheck.removed !== true && oldCheck.revision_reason?.trim() && !newCheck.revision_reason?.trim()) {
        errors.push(`component "${component.id}": check "${id}": revision_reason cannot be dropped once recorded`);
      }
      const weakenings = checkWeakeningReasons(newCheck, oldCheck);
      if (weakenings.length > 0 && !newCheck.revision_reason?.trim()) {
        for (const weakening of weakenings) errors.push(`component "${component.id}": check "${id}": ${weakening}; provide a non-empty revision_reason`);
      }
    }
  }
  return errors;
}

/**
 * Full validation of a plan snapshot. Returns human-readable errors; an empty array
 * means the snapshot is accepted. Every rule here is part of the trust model - see
 * the module doc. Rules:
 *  - structural: non-empty goal and components, unique label-safe ids, known check
 *    kinds, abandon requires a reason, interface endpoints must exist.
 *  - coverage: every component is held by some interface (or says why it is not),
 *    and the interface graph connects all covered components.
 *  - no silent drops: components from the previous snapshot cannot disappear.
 *  - evidence: "done" requires a gate-passed run that declared the component and ran
 *    all of its planned checks.
 */
export function validatePlanSnapshot({ next, previous, evidence, requireSpecSheet = false }: ValidatePlanArgs): string[] {
  const errors: string[] = [];

  if (typeof next.goal !== "string" || next.goal.trim() === "") {
    errors.push("goal must be a non-empty string");
  }
  if (!Array.isArray(next.components) || next.components.length === 0) {
    errors.push("components must be a non-empty array");
    return errors;
  }
  const interfaces = Array.isArray(next.interfaces) ? next.interfaces : [];

  const ids = new Set<string>();
  for (const component of next.components) {
    const id = component?.id;
    if (typeof id !== "string" || !COMPONENT_ID_PATTERN.test(id)) {
      errors.push(`component id ${JSON.stringify(id)} must match ${COMPONENT_ID_PATTERN}`);
      continue;
    }
    if (id === PROBE_COMPONENT) errors.push(`component id "${PROBE_COMPONENT}" is reserved for diagnostic runs`);
    if (ids.has(id)) errors.push(`duplicate component id "${id}"`);
    ids.add(id);
    if (typeof component.description !== "string" || component.description.trim() === "") {
      errors.push(`component "${id}": description must be a non-empty string`);
    }
    if (!PLAN_COMPONENT_STATUSES.includes(component.status)) {
      errors.push(`component "${id}": unknown status ${JSON.stringify(component.status)}`);
    }
    if (component.status === "abandoned" && !component.abandon_reason?.trim()) {
      errors.push(`component "${id}": abandoning requires a non-empty abandon_reason`);
    }
    if (component.status === "blocked" && !component.blocked_reason?.trim()) {
      errors.push(`component "${id}": blocked status requires a non-empty blocked_reason`);
    }
    if (component.status !== "abandoned" && component.bbox_mm === undefined) {
      errors.push(`component "${id}": bbox_mm is required for buildable components`);
    } else if (component.bbox_mm !== undefined) {
      const bbox = component.bbox_mm;
      if (!Array.isArray(bbox) || bbox.length !== 3 || bbox.some((v) => typeof v !== "number" || v <= 0)) {
        errors.push(`component "${id}": bbox_mm must be three positive numbers`);
      }
    }
    if (component.status !== "abandoned" && !Array.isArray(component.checks)) {
      errors.push(`component "${id}": checks are required for buildable components`);
    }
    const checkIds = new Set<string>();
    for (const [index, check] of (component.checks ?? []).entries()) {
      for (const error of validatePlanCheck(check)) errors.push(`component "${id}": check ${index}: ${error}`);
      const checkId = (check as { id?: unknown })?.id;
      if (typeof checkId === "string" && checkId !== "") {
        if (checkIds.has(checkId)) errors.push(`component "${id}": duplicate check id "${checkId}"`);
        checkIds.add(checkId);
      }
    }
    // Every buildable component must carry a targeted, bounded volume check.
    // Volume is the cheapest topology detector: a sealed cavity, missing pocket,
    // or eaten floor shifts it immediately, and the expected range is derived
    // from the component's own intended dimensions - which is exactly the
    // knowledge feature-level checks fail to encode. (Phase 6 live evidence: a
    // gearbox base sealed shut passed holes+bbox+symmetry checks unnoticed.)
    if (component.status !== "abandoned") {
      const volume = (component.checks ?? []).find(
        (check): check is PlanCheckEntry & { range_mm3?: unknown; target?: unknown } =>
          Boolean(check) && check.kind === "volume" && check.target === id,
      );
      if (!volume) {
        errors.push(
          `component "${id}": checks must include a volume check targeting it, e.g. {"id": "volume", "kind": "volume", "range_mm3": [lo, hi], "target": "${id}"} - derive the range (about ±10%) from the component's intended dimensions`,
        );
      } else {
        const range = Array.isArray(volume.range_mm3) ? (volume.range_mm3 as unknown[]) : undefined;
        const lo = typeof range?.[0] === "number" ? (range[0] as number) : undefined;
        const hi = typeof range?.[1] === "number" ? (range[1] as number) : undefined;
        if (lo === undefined || hi === undefined || lo <= 0 || hi < lo) {
          errors.push(`component "${id}": volume check needs range_mm3 [lo, hi] with 0 < lo <= hi`);
        } else if (hi > VOLUME_RANGE_MAX_RATIO * lo) {
          errors.push(
            `component "${id}": volume range [${lo}, ${hi}] is too loose to catch topology mistakes; keep hi <= ${VOLUME_RANGE_MAX_RATIO}x lo (about ±10% around the derived volume)`,
          );
        }
      }
    }
  }

  if (requireSpecSheet && (!Array.isArray(next.spec_sheet) || next.spec_sheet.length === 0)) {
    errors.push("spec_sheet is required for an image-triggered plan");
  }
  // The spec sheet is the durable record of what the agent read off the image; once
  // the plan of record carries one, a later snapshot may not silently drop it.
  if (
    previous?.spec_sheet !== undefined &&
    previous.spec_sheet.length > 0 &&
    (!Array.isArray(next.spec_sheet) || next.spec_sheet.length === 0)
  ) {
    errors.push("spec_sheet cannot be dropped: the previous plan carries one; resubmit it (edited if needed)");
  }
  if (next.spec_sheet !== undefined && !Array.isArray(next.spec_sheet)) {
    errors.push("spec_sheet must be an array");
  } else {
    const rowIds = new Set<string>();
    const componentsById = new Map(next.components.map((component) => [component.id, component]));
    for (const [index, row] of (next.spec_sheet ?? []).entries()) {
      const label = typeof row?.id === "string" && row.id.trim() !== "" ? JSON.stringify(row.id) : String(index);
      for (const error of validatePlanSpecSheetRow(row)) errors.push(`spec_sheet row ${label}: ${error}`);
      if (typeof row?.id === "string" && row.id.trim() !== "") {
        if (rowIds.has(row.id)) errors.push(`spec_sheet row ${label}: duplicate id`);
        rowIds.add(row.id);
      }
      for (const [refIndex, ref] of (Array.isArray(row?.check_refs) ? row.check_refs : []).entries()) {
        const component = componentsById.get(ref.component_id);
        const resolved = component?.checks?.some((check) => (check as { id?: unknown }).id === ref.check_id);
        if (!resolved) {
          errors.push(
            `spec_sheet row ${label}: check_refs[${refIndex}] does not resolve to an existing component check (${JSON.stringify(
              { component_id: ref.component_id, check_id: ref.check_id },
            )})`,
          );
        }
      }
    }
  }
  if (previous?.spec_sheet && Array.isArray(next.spec_sheet)) {
    errors.push(...validateSpecSheetRevision(next.spec_sheet, previous.spec_sheet));
  }

  for (const iface of interfaces) {
    const label = `interface ${JSON.stringify(iface?.a)}/${JSON.stringify(iface?.b)}`;
    if (!ids.has(iface?.a as string) || !ids.has(iface?.b as string)) {
      errors.push(`${label}: endpoints must be component ids`);
      continue;
    }
    if (iface.a === iface.b) errors.push(`${label}: endpoints must differ`);
    if (!PLAN_INTERFACE_KINDS.includes(iface.kind)) {
      errors.push(`${label}: unknown kind ${JSON.stringify(iface.kind)}`);
      continue;
    }
    if (iface.kind === "clearance") {
      if (typeof iface.min_mm !== "number" || iface.min_mm < 0) {
        errors.push(`${label}: clearance requires min_mm >= 0`);
      } else if (iface.max_mm !== undefined && (typeof iface.max_mm !== "number" || iface.max_mm < iface.min_mm)) {
        errors.push(`${label}: max_mm must be a number >= min_mm`);
      }
    }
  }

  // Interface coverage + connectivity (only meaningful with two or more components).
  if (next.components.length >= 2) {
    const covered = new Set<string>();
    for (const iface of interfaces) {
      if (ids.has(iface?.a as string)) covered.add(iface.a);
      if (ids.has(iface?.b as string)) covered.add(iface.b);
    }
    const mustCover = next.components.filter(
      (c) => ids.has(c.id) && c.status !== "abandoned" && !c.free_floating_reason?.trim(),
    );
    for (const component of mustCover) {
      if (!covered.has(component.id)) {
        errors.push(
          `component "${component.id}" is not held by any interface: add a clearance/captive interface, or set free_floating_reason to state why it is legitimately unattached`,
        );
      }
    }
    // Union-find connectivity over the components that interfaces must hold together.
    const parent = new Map<string, string>();
    const find = (x: string): string => {
      let root = x;
      while (parent.get(root) !== root) root = parent.get(root) as string;
      let cursor = x;
      while (parent.get(cursor) !== root) {
        const nextUp = parent.get(cursor) as string;
        parent.set(cursor, root);
        cursor = nextUp;
      }
      return root;
    };
    for (const id of ids) parent.set(id, id);
    for (const iface of interfaces) {
      if (ids.has(iface?.a as string) && ids.has(iface?.b as string)) {
        parent.set(find(iface.a), find(iface.b));
      }
    }
    const anchored = mustCover.filter((c) => covered.has(c.id));
    const roots = new Set(anchored.map((c) => find(c.id)));
    if (roots.size > 1) {
      errors.push(
        "the interface graph is disconnected: every component must be reachable from every other through interfaces, or the assembly falls apart",
      );
    }
  }

  // No silent drops relative to the previous snapshot.
  if (previous) {
    for (const prev of previous.components) {
      if (!ids.has(prev.id)) {
        errors.push(
          `component "${prev.id}" from the previous plan is missing: keep it (status "abandoned" with abandon_reason) instead of dropping it silently`,
        );
      }
    }
    errors.push(...validateCheckMonotonicity(next, previous));
  }

  // Evidence-checked done transitions.
  for (const component of next.components) {
    if (component.status !== "done" || !ids.has(component.id)) continue;
    const record = evidence.get(component.id);
    if (!record) {
      errors.push(
        `component "${component.id}" cannot be "done": no gate-passed run has declared COMPONENT = "${component.id}"`,
      );
      continue;
    }
    const previousComponent = previous?.components.find((candidate) => candidate.id === component.id);
    const isDoneTransition = previousComponent?.status !== "done";
    const isImagePlan = Boolean(next.spec_sheet?.length || previous?.spec_sheet?.length);
    if (isDoneTransition && isImagePlan) {
      const review = component.form_review;
      const entries = Array.isArray(review?.views) ? review.views : [];
      const entriesByView = new Map(entries.map((entry) => [entry?.view, entry]));
      for (const view of FORM_REVIEW_VIEWS) {
        const entry = entriesByView.get(view);
        if (!entry) {
          errors.push(`component "${component.id}" cannot be "done": form_review is missing the ${view} view`);
          continue;
        }
        if (entry.verdict !== "match" && entry.verdict !== "mismatch") {
          errors.push(`component "${component.id}" cannot be "done": form_review ${view} verdict must be "match" or "mismatch"`);
        }
        if (typeof entry.note !== "string" || entry.note.trim() === "") {
          errors.push(`component "${component.id}" cannot be "done": form_review ${view} note must be non-empty`);
        }
        if (entry.verdict === "mismatch") {
          errors.push(`component "${component.id}" cannot be "done": form_review ${view} verdict is mismatch`);
        }
      }
      const seenViews = new Set<FormReviewView>();
      for (const entry of entries) {
        if (!FORM_REVIEW_VIEWS.includes(entry?.view as FormReviewView)) {
          errors.push(`component "${component.id}" cannot be "done": unknown form_review view ${JSON.stringify(entry?.view)}`);
        } else if (seenViews.has(entry.view)) {
          errors.push(`component "${component.id}" cannot be "done": duplicate form_review view "${entry.view}"`);
        } else {
          seenViews.add(entry.view);
        }
      }
      if (typeof review?.evidence_id !== "string" || review.evidence_id.trim() === "") {
        errors.push(`component "${component.id}" cannot be "done": form_review evidence_id must name the latest gate-passed evidence`);
      } else if (review.evidence_id !== record.evidenceId) {
        errors.push(
          `component "${component.id}" cannot be "done": form_review evidence_id ${JSON.stringify(review.evidence_id)} does not match latest gate-passed evidence ${JSON.stringify(record.evidenceId)}`,
        );
      }
    }
    for (const check of component.checks ?? []) {
      if (check.removed) continue;
      // Compare on the harness projection: run CHECKS entries never carry the
      // plan-only metadata keys (id, audit fields).
      if (!record.checks.has(canonical(harnessCheckForm(check)))) {
        errors.push(
          `component "${component.id}" cannot be "done": its planned check ${JSON.stringify(harnessCheckForm(check))} was not part of the gate-passed run that declared it`,
        );
      }
    }
  }

  return errors;
}

/**
 * Best-effort parse of a script's COMPONENT declaration for budget attribution.
 * The harness echo (measurements.component) stays the trust anchor for evidence;
 * this only decides which budget bucket a run drains before it executes.
 * Accepts `COMPONENT = "lid"` and `COMPONENT = ["base", "lid"]` with either quote
 * style; returns undefined when no declaration is found.
 */
/** Budget bucket for a run: a component id, "assembly" for multi-component runs, "probe", or "general". */
export function runBudgetBucket(declaration: string[] | undefined): string {
  if (!declaration || declaration.length === 0) return "general";
  if (declaration.length === 1) return declaration[0] as string;
  return "assembly";
}

/** Compact single-line rendering for tool-result text and the stop-gate nudge. */
export function describePlanStatus(plan: Plan): string {
  const byStatus = new Map<PlanComponentStatus, number>();
  for (const component of plan.components) {
    byStatus.set(component.status, (byStatus.get(component.status) ?? 0) + 1);
  }
  const parts = PLAN_COMPONENT_STATUSES.filter((s) => byStatus.has(s)).map(
    (s) => `${byStatus.get(s)} ${s}`,
  );
  return `${plan.components.length} components (${parts.join(", ")}), ${plan.interfaces?.length ?? 0} interfaces`;
}

/** Type guard used by UI and tests. */
export function isPlanToolResult(message: unknown): message is AgentMessage & { details: { plan: Plan } } {
  const m = message as ToolResultLike;
  return (
    m?.role === "toolResult" &&
    m.toolName === UPDATE_PLAN_TOOL_NAME &&
    !m.isError &&
    typeof m.details?.plan === "object" &&
    m.details?.plan !== null
  );
}
