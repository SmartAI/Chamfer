import type {
  FusionAffectedReferenceDto,
  FusionCheckResultDto,
  FusionEngineeringChangeDto,
  FusionEngineeringSnapshotDto,
  FusionExpectedEffect,
  FusionReconciliationReason,
  FusionRefreshedReferenceDto,
} from "@chamfer/shared";
import { stableJson } from "./mcpPayload";
import { evaluateFusionChecks } from "./inspection";

export interface FusionReconciliationAnalysis {
  status: "reconciled" | "needs-user";
  reason: FusionReconciliationReason;
  summary: string;
  changes: FusionEngineeringChangeDto[];
  refreshedReferences: FusionRefreshedReferenceDto[];
}

const COLLECTIONS = ["parameters", "sketches", "features", "bodies"] as const;

/** Re-baseline checks whose numeric target is exactly what the user changed in
 * authoritative Fusion. Other checks remain requirements and may escalate. */
export function refreshFusionChecksForManualState(
  snapshot: FusionEngineeringSnapshotDto,
  effects: readonly FusionExpectedEffect[],
): FusionCheckResultDto[] {
  const refreshed = effects.map((effect): FusionExpectedEffect => {
    const body = effect.kind === "dimensions" || effect.kind === "volume"
      ? (effect.bodyId ? snapshot.bodies.find((candidate) => candidate.id === effect.bodyId) : snapshot.bodies[0])
      : undefined;
    if (effect.kind === "dimensions" && body) {
      return { ...effect, expectedMm: [...body.boundingBoxMm] as [number, number, number] };
    }
    if (effect.kind === "volume" && body) {
      return { kind: "volume", minMm3: body.volumeMm3, maxMm3: body.volumeMm3,
        ...(effect.bodyId ? { bodyId: effect.bodyId } : {}) };
    }
    return effect;
  });
  return evaluateFusionChecks(snapshot, refreshed);
}

function changedFields(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((key) => key !== "nativeToken" && stableJson(before[key]) !== stableJson(after[key]))
    .sort();
}

function describeChanges(before: FusionEngineeringSnapshotDto, after: FusionEngineeringSnapshotDto): FusionEngineeringChangeDto[] {
  const changes: FusionEngineeringChangeDto[] = [];
  // Only a real design-type change (e.g. parametric -> direct) is a structural
  // reconciliation. rootComponent ("(Unsaved)" vs "Untitled") and timelineMarker
  // flip without an engineering difference and must not be reported as a manual
  // edit, or an incremental build stalls on its own benign revision churn.
  if (before.designIntent.designType !== after.designIntent.designType) {
    changes.push({ kind: "design", entityId: "design", name: after.designIntent.rootComponent, change: "modified",
      fields: ["designType"] });
  }
  for (const collection of COLLECTIONS) {
    const kind = collection === "parameters" ? "parameter" : collection === "sketches" ? "sketch" : collection === "features" ? "feature" : "body";
    const preceding = new Map(before[collection].map((item) => [item.id, item]));
    const observed = new Map(after[collection].map((item) => [item.id, item]));
    for (const [id, item] of preceding) {
      const next = observed.get(id);
      if (!next) changes.push({ kind, entityId: id, name: item.name, change: "removed", fields: [] });
      else {
        const fields = changedFields(item as unknown as Record<string, unknown>, next as unknown as Record<string, unknown>);
        if (fields.length > 0) changes.push({ kind, entityId: id, name: next.name, change: "modified", fields });
      }
    }
    for (const [id, item] of observed) {
      if (!preceding.has(id)) changes.push({ kind, entityId: id, name: item.name, change: "added", fields: [] });
    }
  }
  const precedingMaterials = new Map(before.materials.map((item) => [item.id, item]));
  const observedMaterials = new Map(after.materials.map((item) => [item.id, item]));
  for (const [id, item] of precedingMaterials) if (!observedMaterials.has(id)) {
    changes.push({ kind: "material", entityId: id, name: item.name, change: "removed", fields: [] });
  }
  for (const [id, item] of observedMaterials) if (!precedingMaterials.has(id)) {
    changes.push({ kind: "material", entityId: id, name: item.name, change: "added", fields: [] });
  }
  return changes.sort((a, b) => `${a.kind}:${a.entityId}`.localeCompare(`${b.kind}:${b.entityId}`));
}

function summaryFor(changes: readonly FusionEngineeringChangeDto[]): string {
  if (changes.length === 0) return "Fusion reported a new engineering revision without a normalized state difference.";
  return changes.map((change) => {
    const fields = change.fields.length > 0 ? ` (${change.fields.join(", ")})` : "";
    return `${change.change} ${change.kind} ${change.name}${fields}`;
  }).join("; ");
}

export function reconcileFusionSnapshots(
  preceding: FusionEngineeringSnapshotDto,
  observed: FusionEngineeringSnapshotDto,
  activeReferences: readonly FusionAffectedReferenceDto[] = [],
  refreshedChecks: readonly FusionCheckResultDto[] = [],
): FusionReconciliationAnalysis {
  const identityCounts = new Map<string, number>();
  const tokenCounts = new Map<string, number>();
  for (const entity of observed.entities) {
    const key = `${entity.kind}:${entity.id}`;
    identityCounts.set(key, (identityCounts.get(key) ?? 0) + 1);
    if (entity.nativeToken) tokenCounts.set(entity.nativeToken, (tokenCounts.get(entity.nativeToken) ?? 0) + 1);
  }
  if ([...identityCounts.values()].some((count) => count !== 1) || [...tokenCounts.values()].some((count) => count !== 1)) {
    return { status: "needs-user", reason: "ambiguous-entity-identity",
      summary: "Fusion returned more than one candidate for a high-level entity identity; targeted mutation is blocked.",
      changes: describeChanges(preceding, observed), refreshedReferences: [] };
  }
  const refreshedReferences: FusionRefreshedReferenceDto[] = [];
  for (const reference of activeReferences) {
    const entity = observed.entities.find((candidate) => candidate.kind === reference.kind && candidate.id === reference.id);
    if (!entity?.nativeToken) {
      return { status: "needs-user", reason: "referenced-entity-missing",
        summary: `The active ${reference.kind} reference ${reference.id} no longer resolves after the manual Fusion edit.`,
        changes: describeChanges(preceding, observed), refreshedReferences };
    }
    refreshedReferences.push({ ...reference, nativeToken: entity.nativeToken,
      ...(entity.semanticDescriptor ? { semanticDescriptor: entity.semanticDescriptor } : {}) });
  }
  if (observed.designIntent.designType !== "parametric") {
    return { status: "needs-user", reason: "unsupported-engineering-state",
      summary: "The manual Fusion edit changed the design outside the supported parametric-part state.",
      changes: describeChanges(preceding, observed), refreshedReferences };
  }
  const changes = describeChanges(preceding, observed);
  const failedChecks = refreshedChecks.filter((check) => check.status !== "passed");
  if (failedChecks.length > 0) {
    return { status: "needs-user", reason: "active-check-conflict",
      summary: `The manual Fusion edit conflicts with active requirements: ${failedChecks.map((check) => check.detail).join("; ")}`,
      changes, refreshedReferences };
  }
  // Manual structural edits - added, removed, or reshaped sketches and features -
  // are the user's authoritative design work and reconcile automatically. The
  // domain contract escalates only on a genuine conflict, and the specific
  // conflicts are already fail-closed above: a requirement the edit breaks
  // (active-check-conflict), a needed entity it deletes (referenced-entity-
  // missing), an identity it makes ambiguous, or a design mode we cannot
  // support. A blanket "structural edit needs the user" block stalled
  // autonomous builds on edits nothing actually depended on.
  // A revision hash change with ZERO normalized engineering difference is
  // benign churn (Fusion recomputes revision-relevant fields around undo,
  // rollback, and camera work). There is literally nothing to ask the user
  // about - the design is unchanged - so blocking here only stalled autonomous
  // builds on a confirm string. Reconcile it automatically.
  if (changes.length === 0) {
    return { status: "reconciled", reason: "unnormalized-revision-change",
      summary: "Fusion reported a new engineering revision without a normalized state difference; the design is unchanged.",
      changes, refreshedReferences };
  }
  return { status: "reconciled", reason: "unambiguous-manual-edit", summary: summaryFor(changes), changes, refreshedReferences };
}
