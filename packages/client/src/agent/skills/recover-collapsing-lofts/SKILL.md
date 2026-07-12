---
name: recover-collapsing-lofts
description: Recover collapsing loft transitions, pinched or twisted bodies, BRep failures, and tessellation failure after lofting. Use when curved transition geometry fails to build or mesh.
---

## Symptom

Use this recipe when a loft pinches, twists, collapses, throws a BRep error, or builds but causes a tessellation failure.

## Recovery ladder

1. Isolate the smallest failing pair of closed, planar sections and confirm their order and orientation.
2. Rework section respacing so adjacent profiles change gradually and remain monotonic along the travel axis.
3. Try `loft(..., ruled=True)` to replace unstable smooth interpolation with straight transitions.
4. Split a long transition into shorter lofts, build them as overlapping bodies, and fuse only after each body verifies independently.
5. Attempt an alternative construction before simplifying the form: use revolve for axisymmetric bodies or sweep for a stable profile following a curved spine.

```python
transition = loft(sections, ruled=True)
assert transition.is_valid()
assert len(transition.solids()) == 1
```

Do not replace a required curved silhouette with a blocky envelope merely to make tessellation pass.
After recovery, verify the isolated transition first, then restore additive details and cosmetic operations.
