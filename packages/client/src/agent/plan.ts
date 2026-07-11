import type { AgentMessage } from "@earendil-works/pi-agent-core";

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

export type PlanComponentStatus = "todo" | "building" | "done" | "abandoned";

export const PLAN_COMPONENT_STATUSES: readonly PlanComponentStatus[] = [
  "todo",
  "building",
  "done",
  "abandoned",
];

/** One CHECKS entry as the harness understands it; `kind` is validated, the rest is passed through. */
export interface PlanCheckEntry {
  kind: string;
  [key: string]: unknown;
}

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
  /** Exempts the component from interface coverage; must say why it is legitimately unattached. */
  free_floating_reason?: string;
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
}

/** CHECKS kinds the harness currently evaluates; plan checks outside this set are rejected. */
export const KNOWN_CHECK_KINDS: ReadonlySet<string> = new Set([
  "hole_through",
  "hole_blind",
  "hole_internal",
  "clearance",
  "bbox",
  "volume",
  "count_faces",
  "count_edges",
  "symmetric",
]);

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
 * Whether some gate-passed run declared every non-abandoned component at once -
 * the assembly run where interface clearances are actually measured. Per-component
 * "done" statuses cannot certify the interfaces (Phase 6 live run: both components
 * were done while nothing had verified the lid actually rests on the flange), so a
 * plan with interfaces only counts as finished once this evidence exists.
 */
export function hasAssemblyEvidence(plan: Plan, messages: readonly unknown[]): boolean {
  const required = plan.components.filter((c) => c.status !== "abandoned").map((c) => c.id);
  if (required.length < 2 || (plan.interfaces ?? []).length === 0) return true;
  for (const message of messages) {
    const m = message as ToolResultLike;
    if (m?.role !== "toolResult" || m.toolName !== "run_build123d" || m.isError) continue;
    if (m.details?.gate?.status !== "passed") continue;
    const ids = new Set(runComponentIds(m.details?.measurements));
    if (required.every((id) => ids.has(id))) return true;
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
    for (const id of ids) evidence.set(id, { checks });
  }
  return evidence;
}

export interface ValidatePlanArgs {
  next: Plan;
  previous: Plan | undefined;
  evidence: Map<string, ComponentEvidence>;
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
export function validatePlanSnapshot({ next, previous, evidence }: ValidatePlanArgs): string[] {
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
    if (component.bbox_mm !== undefined) {
      const bbox = component.bbox_mm;
      if (!Array.isArray(bbox) || bbox.length !== 3 || bbox.some((v) => typeof v !== "number" || v <= 0)) {
        errors.push(`component "${id}": bbox_mm must be three positive numbers`);
      }
    }
    for (const check of component.checks ?? []) {
      if (!check || typeof check.kind !== "string" || !KNOWN_CHECK_KINDS.has(check.kind)) {
        errors.push(`component "${id}": unknown check kind ${JSON.stringify(check?.kind)}`);
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
          Boolean(check) && check.kind === "volume",
      );
      if (!volume || volume.target !== id) {
        errors.push(
          `component "${id}": checks must include a volume check targeting it, e.g. {"kind": "volume", "range_mm3": [lo, hi], "target": "${id}"} - derive the range (about ±10%) from the component's intended dimensions`,
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
    for (const check of component.checks ?? []) {
      if (!record.checks.has(canonical(check))) {
        errors.push(
          `component "${component.id}" cannot be "done": its planned check ${JSON.stringify(check)} was not part of the gate-passed run that declared it`,
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
export function parseComponentDeclaration(code: string): string[] | undefined {
  const match = /^[ \t]*COMPONENT[ \t]*=[ \t]*(.+)$/m.exec(code);
  if (!match) return undefined;
  const raw = (match[1] ?? "").split("#")[0]?.trim() ?? "";
  const single = /^["']([^"']+)["']$/.exec(raw);
  if (single) return [single[1] as string];
  if (raw.startsWith("[")) {
    const ids = [...raw.matchAll(/["']([^"']+)["']/g)].map((m) => m[1] as string);
    if (ids.length > 0) return ids;
  }
  return undefined;
}

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
