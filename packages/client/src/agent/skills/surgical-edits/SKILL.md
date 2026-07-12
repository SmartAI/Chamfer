---
name: surgical-edits
description: Change an existing, verified model with the smallest possible script edit instead of rebuilding it. Load whenever the user asks to add, remove, resize, or move a feature on geometry that already passed the gate, or when an "edit" keeps regressing parts that used to be correct.
---

## When to reach for this

Use this the moment a request modifies something that already exists: "add a slot", "make the holes 5 mm", "remove the boss", "move it 10 mm left".
Edits fail differently from builds: the enemy is collateral damage to the parts that were already right.

## Invariants

- Start from the last gate-passed script, verbatim. Change only the lines the request touches; every other line is evidence of verified behavior and must survive character-for-character.
- Never switch construction strategy during an edit. A working extrude-based bracket gets its new slot as one more operation, not a re-design around sweep or loft.
- Express the edit through the existing parameters. If a dimension changes, change the parameter, not a hard-coded copy of its old value somewhere downstream.
- Anchor new features to geometry (faces, axes, existing parameters), never to coordinates copied from a previous run's measurements output; those numbers go stale with the first parameter change.
- Keep every existing check and EXPECT entry, then add checks for the edit. The old checks are the collateral-damage alarm: if one fails after the edit, the edit leaked.
- Predict the numbers before running: an added pocket lowers volume by its own displaced volume and must not change the outer bounding box. Assert the prediction, then run.
- If the request genuinely invalidates the old structure (topology change, different dominant form), say so and rebuild deliberately - a rebuild pretending to be an edit is the worst of both.

## Canonical recipes

Version 2 of a verified bracket: the single surgical change is marked, the outer envelope and every prior feature are asserted unchanged:

{{snippet:snippets/add_slot_edit.py}}

## Failure signatures

- A previously passing check fails after the edit: the new feature touched geometry it should not have. Shrink or re-anchor the new cutter; do not "fix" the old check.
- Volume changed by more than the feature explains: collateral cut. Compare the delta against the predicted displaced volume.
- The bounding box changed on a feature-only edit: the edit moved or scaled the part. Re-read the diff; something outside the marked lines changed.
- The same request keeps producing a fully rewritten script: strategy drift. Return to the last passing script and constrain the diff to the feature.

## Go deeper

- Predict-then-verify the volume delta of an edit: `load_skill("surgical-edits", resource="snippets/volume_delta_probe.py")`.
- `search_docs` queries: "Mode.SUBTRACT", "extrude until", "offset faces", "split Keep".
