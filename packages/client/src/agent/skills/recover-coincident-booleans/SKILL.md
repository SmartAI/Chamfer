---
name: recover-coincident-booleans
description: Recover coincident-face boolean failures, zero-thickness junctions, invalid solids, and cuts that stop exactly on a target face. Use when fuse, cut, or intersect fails despite apparently touching operands.
---

## Symptom

Use this recipe when a boolean fails, returns an invalid solid, leaves a sliver, or creates a zero-thickness junction where operand faces are coincident.

## Recovery ladder

1. Test only the target and tool operands so the failing pair is unambiguous.
2. Extend subtractive tools through the target by 1 mm or more on both sides instead of ending them exactly on a face.
3. For additive features, move one operand across the shared face to create positive-volume overlap.
4. Avoid zero-thickness edge or face junctions by changing the tool extent or offset by a small, intentional amount.
5. Restore later booleans only after the isolated operation yields one valid solid.

For a through cut spanning `z = 0` through `z = height`:

```python
overshoot = 1.0
tool = Box(width, depth, height + 2 * overshoot).translate((x, y, -overshoot))
result = target.cut(tool)
assert result.is_valid()
```

Do not hide the failure with a tolerance change or delete the requested feature.
Verify solid count, validity, bounding box, and volume delta after the recovered boolean.
