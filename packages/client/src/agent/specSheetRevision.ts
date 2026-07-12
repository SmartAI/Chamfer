import type { PlanSpecSheetRow } from "./planChecks";

function normalizedRefs(row: PlanSpecSheetRow): string[] {
  return (row.check_refs ?? [])
    .map((ref) => `${ref.component_id}\u0000${ref.check_id}`)
    .sort();
}

function sameRefs(a: PlanSpecSheetRow, b: PlanSpecSheetRow): boolean {
  const left = normalizedRefs(a);
  const right = normalizedRefs(b);
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function hasReason(row: PlanSpecSheetRow): boolean {
  return Boolean(row.revision_reason?.trim());
}

function hasFreshReason(next: PlanSpecSheetRow, previous: PlanSpecSheetRow): boolean {
  const nextReason = next.revision_reason?.trim();
  if (!nextReason) return false;
  const previousReason = previous.revision_reason?.trim();
  return !previousReason || (nextReason !== previousReason && nextReason.startsWith(previousReason));
}

function hasLegacyRefs(row: PlanSpecSheetRow): boolean {
  return (row.check_refs ?? []).some((ref) => typeof (ref as { check_id?: unknown }).check_id !== "string");
}

/**
 * Enforces the append-only audit contract for already-published spec-sheet rows.
 * Text remains editable, but evidence links cannot disappear or change silently.
 */
export function validateSpecSheetRevision(
  nextRows: readonly PlanSpecSheetRow[],
  previousRows: readonly PlanSpecSheetRow[],
): string[] {
  const errors: string[] = [];
  const nextById = new Map(nextRows.map((row) => [row.id, row]));

  for (const previous of previousRows) {
    const next = nextById.get(previous.id);
    if (!next) {
      errors.push(`spec_sheet row ${JSON.stringify(previous.id)} from the previous plan is missing: published rows cannot be deleted`);
      continue;
    }

    if (previous.revision_reason?.trim() && !hasReason(next)) {
      errors.push(`spec_sheet row ${JSON.stringify(previous.id)}: revision_reason cannot be dropped once recorded`);
    }

    const previousHadRefs = (previous.check_refs?.length ?? 0) > 0;
    const nextHasRefs = (next.check_refs?.length ?? 0) > 0;
    if (previousHadRefs && !nextHasRefs && !hasFreshReason(next, previous)) {
      errors.push(
        previous.revision_reason?.trim()
          ? `spec_sheet row ${JSON.stringify(previous.id)} was downgraded to unverifiable; append a new explanation while preserving the previous revision_reason`
          : `spec_sheet row ${JSON.stringify(previous.id)} was downgraded to unverifiable; provide a non-empty revision_reason`,
      );
    } else if (
      previousHadRefs &&
      nextHasRefs &&
      !hasLegacyRefs(previous) &&
      !sameRefs(previous, next) &&
      !hasFreshReason(next, previous)
    ) {
      errors.push(
        previous.revision_reason?.trim()
          ? `spec_sheet row ${JSON.stringify(previous.id)} was repointed to different checks; append a new explanation while preserving the previous revision_reason`
          : `spec_sheet row ${JSON.stringify(previous.id)} was repointed to different checks; provide a non-empty revision_reason`,
      );
    }
  }

  return errors;
}
