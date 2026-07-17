import type { FusionAffectedReferenceDto, FusionEngineeringSnapshotDto } from "@chamfer/shared";
import { stableJson } from "./mcpPayload";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function fusionIntentPreservationViolations(
  preceding: FusionEngineeringSnapshotDto,
  observed: FusionEngineeringSnapshotDto,
  affected: readonly FusionAffectedReferenceDto[],
): string[] {
  const violations: string[] = [];
  const affectedKeys = new Set(affected.map((reference) => `${reference.kind}:${reference.id}`));
  // A build into an empty design has no prior engineering intent to preserve, so
  // the "unaffected X changed/removed" comparisons below are vacuous. The new-entity
  // identity requirement must also not apply here: a from-scratch part legitimately
  // creates entities the model cannot all register (for example the occurrences a
  // circular or rectangular pattern generates), and requiring a Chamfer UUID on each
  // would falsely roll back an otherwise correct build. Targeted edits into an
  // existing design still get the full check.
  // "Empty" means no prior engineering intent. The snapshot always seeds the
  // root component into `entities`, so `entities.length === 0` is never true -
  // define empty as "no non-component entities" instead, or this guard is dead
  // code and a correct from-scratch build gets rolled back.
  const fromScratch = preceding.parameters.length === 0 && preceding.sketches.length === 0
    && preceding.features.length === 0 && preceding.bodies.length === 0
    && preceding.entities.every((entity) => entity.kind === "component");
  if (preceding.designIntent.designType !== observed.designIntent.designType) violations.push("design type changed");
  // The root component name is deliberately NOT compared. Fusion mutates it
  // non-deterministically as features land - the unsaved suffix appears and
  // disappears ("Motor Controller Baseplate (Unsaved)" <-> "... "), and an
  // untitled document flips between "(Unsaved)" and "Untitled" - with no change
  // to engineering intent. The revision fingerprint already excludes it for the
  // same reason; comparing it here would roll back a correct action whenever the
  // suffix toggled. Genuine reparenting shows up as removed/renamed entities in
  // the compares below.

  const compare = <T extends { id: string; name: string }>(kind: FusionAffectedReferenceDto["kind"], before: T[], after: T[], fields: (keyof T)[],
    exempt?: (item: T) => boolean) => {
    const afterById = new Map(after.map((item) => [item.id, item]));
    for (const item of before) {
      if (affectedKeys.has(`${kind}:${item.id}`)) continue;
      if (exempt?.(item)) continue;
      const next = afterById.get(item.id);
      if (!next) { violations.push(`unaffected ${kind} ${item.name} was removed`); continue; }
      for (const field of fields) if (stableJson(item[field]) !== stableJson(next[field])) {
        violations.push(`unaffected ${kind} ${item.name} changed ${String(field)}`);
      }
    }
  };
  // Fusion auto-creates model parameters (d1, d2, ...) for every feature
  // dimension and deletes or renumbers them whenever their owning feature is
  // deleted or rebuilt. They are kernel bookkeeping, not user intent, and the
  // agent cannot declare them affected (they are not registered entities), so
  // holding them to the preservation contract deadlocked every legitimate
  // delete-and-re-author of the agent's own feature (observed live: rebuilding
  // an owned housing rolled back on "unaffected parameter d7 was removed").
  // User-authored parameters carry meaningful names and stay fully protected.
  const autoModelParameter = (parameter: { name: string }) => /^d\d+$/.test(parameter.name);
  compare("parameter", preceding.parameters, observed.parameters, ["name", "expression", "valueMm", "unit"], autoModelParameter);
  compare("sketch", preceding.sketches, observed.sketches, ["name", "plane", "constraints", "constraintDetails"]);
  compare("feature", preceding.features, observed.features, ["name", "type", "suppressed"]);
  compare("body", preceding.bodies, observed.bodies, ["name", "material", "appearance"]);

  // Only features and sketches are the durable, token-addressable entities the
  // model is expected to register for later targeted edits. Parameters are
  // referenced by name, and Fusion auto-creates feature-driven model parameters
  // (extrude distances, fillet radii, pattern counts) the model never authors;
  // bodies can be multiplied by a pattern, which copies the Chamfer UUID
  // attribute onto every occurrence. Requiring a UUID on those - or treating
  // their natural duplication as an ambiguous identity - would falsely roll back
  // a correct parametric build. Scope both identity rules to feature/sketch.
  // Durable-identity invariants only matter when Chamfer must later resolve an
  // edit target, i.e. a targeted edit that names affectedReferences. A purely
  // additive build action (every action while building a part up from scratch)
  // legitimately creates features the model may not have registered yet, and a
  // missing UUID there is not structural damage - failing it would roll the whole
  // action back and, via the rollback path, brick the session. Enforce identity
  // only for targeted edits, and only on the durable feature/sketch entities.
  const identityRelevant = (kind: string): boolean => kind === "feature" || kind === "sketch";
  const enforceIdentity = affected.length > 0 && !fromScratch;
  const beforeEntities = new Set(preceding.entities.map((entity) => `${entity.kind}:${entity.id}`));
  const identityCounts = new Map<string, number>();
  for (const entity of observed.entities) {
    if (!enforceIdentity || !identityRelevant(entity.kind)) continue;
    const key = `${entity.kind}:${entity.id}`;
    identityCounts.set(key, (identityCounts.get(key) ?? 0) + 1);
    if (!beforeEntities.has(key) && (!entity.chamferId || !UUID.test(entity.chamferId) || !entity.semanticDescriptor)) {
      violations.push(`new ${entity.kind} ${entity.name} lacks a namespaced UUID identity and semantic descriptor`);
    }
  }
  for (const [key, count] of identityCounts) if (count !== 1) violations.push(`entity identity ${key} resolves ${count} times`);
  return [...new Set(violations)];
}
