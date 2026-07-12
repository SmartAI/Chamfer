---
name: selectors-and-patterns
description: Select edges, faces, and solids by geometry (filter_by, sort_by, group_by, Select) and repeat features with GridLocations, PolarLocations, and mirror. Load before fillets, chamfers, or patterned features, or when a selection hits the wrong topology or a symmetry check fails.
---

## When to reach for this

Use this whenever an operation targets a subset of topology (fillet these edges, drill that face) or a feature repeats (bolt circles, grids, mirrored halves).

## Invariants

- Select by geometric meaning, never by raw index. `edges()[7]` is meaningless after any upstream change; `faces().sort_by(Axis.Z)[-1]` says "the top face" and survives edits.
- Own the topology you select: take fillet edges from the face they belong to (`face.edges()`), not from the whole part filtered loosely. Loose filters catch look-alike edges elsewhere.
- Compose selectors: `filter_by(GeomType.CIRCLE)`, `filter_by(Axis.Z)`, `group_by(Axis.Z)[-1]`, `sort_by(SortBy.LENGTH)`. Each step narrows; print the candidate count before operating on it.
- Selections go stale: every boolean, fillet, or added feature rebuilds topology. Re-select after each mutating operation; in builder mode use `Select.LAST` or `Select.NEW` to scope to what the previous operation created.
- Build one instance of a repeated feature and verify it before patterning. `GridLocations` and `PolarLocations` multiply whatever is wrong along with whatever is right.
- After patterning, verify count and spacing numerically (hole census, face counts, bounding boxes of the instances); after `mirror`, run the symmetric check rather than trusting the view.

## Canonical recipes

Fillet only the top-face edges, selected from the face that owns them:

{{snippet:snippets/fillet_top_edges.py}}

One verified hole, then a bolt circle by `PolarLocations`, with the count asserted:

{{snippet:snippets/polar_holes.py}}

## Failure signatures

- A fillet or chamfer lands on the wrong edges, or fails with a radius error: the selection caught extra topology. Narrow via the owning face and print candidates first.
- A selector that worked stops matching after an edit: stale selection. Re-derive it from the current shape.
- The pattern produced overlapping or merged features: spacing is smaller than the feature. Check instance spacing against feature size before cutting.
- A symmetric check fails after mirror: the seed geometry straddles the mirror plane or was already off-center. Verify the seed's bounding box against the plane first.
- `filter_by` returns nothing: the property is wrong for the topology kind (e.g. filtering edges by a face axis). Probe with `group_by` and counts.

## Go deeper

- Print selection candidates step by step before operating: `load_skill("selectors-and-patterns", resource="snippets/selector_probe.py")`.
- `lookup_docs` topic `selectors-measurements` covers runtime-specific selection practice; `search_docs` queries: "filter_by GeomType", "group_by Axis", "Select.LAST builder", "PolarLocations count".
