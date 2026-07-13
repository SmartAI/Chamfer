---
name: recover-disjoint-solids
description: Recover additive features when the verification gate reports multiple bodies, including the exact failure "bodies: expected 1, found 3". Use when bosses, ribs, fins, buttons, or connectors remain separate after fuse or union.
---

## Symptom

Use this recipe when an additive feature looks attached but the verification gate reports more bodies than expected.
The operands are usually tangent, separated by a tiny gap, or touching only at a face or edge.

## Recovery ladder

1. Isolate the base and one failing feature, then inspect their bounding boxes to confirm the intended contact region.
2. Create real overlap: bury the feature base 1-2 mm into the receiving body so the operands interpenetrate by real volume.
3. Fuse the overlapping operands and verify `len(result.solids()) == 1` before patterning the feature.
4. Add repeated features one at a time, preserving the same overlap, and verify the body count after each fuse.

For a boss beginning on the top face at `z = height`, start it below that face:

```python
overlap = 1.5
boss = Cylinder(boss_radius, boss_height + overlap).translate((x, y, height - overlap))
result = base.fuse(boss)
assert len(result.solids()) == 1
```

Never abandon the feature to clear the body count.
If increasing overlap does not fuse, verify placement and fuse the smallest operand pair in isolation before restoring the full model.

## Success check

The recovered model has one solid, remains valid, retains the requested feature count, and has a plausible volume increase smaller than the sum of the separate operands because their buried regions overlap.
