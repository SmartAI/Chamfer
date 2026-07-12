---
name: booleans-and-features
description: Fuse, cut, and intersect bodies robustly and order feature operations correctly. Load before joining or cutting multi-part geometry, or after a boolean produces the wrong body count, a sliver, an invalid solid, or damage to unrelated geometry.
---

## When to reach for this

Use this whenever bodies must join into one part, a tool must remove material, or a sequence of features (bosses, ribs, holes, fillets) builds up a single component.

## Invariants

- Additive bodies must overlap by real volume to fuse. Tangent or coincident face contact is not a robust union: it may produce two solids or an invalid shell. Bury the joining feature about 1 mm into its neighbor, then verify one solid.
- Extend subtractive tools past both faces they pierce. A cutter that ends exactly on a surface leaves a coincident-face sliver or a hole the census reports as blind. One millimeter of overshoot on each side costs nothing.
- Keep cutters narrow: a tool sized "generously" removes material from geometry it was never aimed at. Check the volume delta against the volume the cut should remove.
- Order operations: dominant material and voids first, fuse additive features next, cut shared holes after fusion, fillets and chamfers last. A hole cut before a fuse can be sealed by the fuse; a fillet applied early invalidates later selections.
- In algebra mode, name intermediates and inspect the failing operand pair alone. In builder mode, `Mode.SUBTRACT` scopes to the active part; do not mix the two mental models in one script.
- `intersect()` can return a `ShapeList`, not a single shape; handle both. Never use face count alone as proof a boolean worked: use solid count, volume, validity, and the hole census together.

## Canonical recipes

Two plates joined by a buried connector; the assertion is the point - one solid, volume close to the sum minus the overlap:

{{snippet:snippets/buried_connector.py}}

A through-slot cut with a tool extended past both faces, verified by volume delta:

{{snippet:snippets/through_cutter.py}}

## Failure signatures

- Gate reports more bodies than expected after a union: the parts only touch. Increase the overlap, then re-verify solid count.
- A "through" hole reports blind or internal in the census: the cutter stopped on a face. Extend it past both surfaces.
- The result is invalid or has absurd area after a boolean: coincident faces between operands. Nudge the tool so faces are never exactly shared.
- Volume dropped far more than the feature explains: the cutter clipped unrelated geometry. Shrink or reposition the tool and compare volume deltas.
- An earlier feature disappeared after a later fuse: operation order sealed it. Re-order so shared cuts happen after all fusing.

## Go deeper

- Diagnose a failing boolean operand-by-operand: `load_skill("booleans-and-features", resource="snippets/boolean_probe.py")`.
- `search_docs` queries: "Mode.SUBTRACT builder", "Part algebra operators", "intersect ShapeList", "offset shell".
