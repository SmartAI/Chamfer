---
name: fusion-verification-and-repair
version: 1.1.0
description: Verify and finish a Fusion part - the completion contract verified once at the final inspection, reading per-action measured feedback, interference-free feature layout with mandatory visual verification of the rendered view sheet, repairing wrong features with delete_owned, and the final full-inspection done transition. Load alongside fusion-parametric-features before building or repairing parametric Fusion geometry.
---

# Fusion verification and repair

## Completion contract and measured feedback

The plan (one `update_plan` before the first action) is the completion contract for the FINISHED part: one `fusion_effect` check per final observable effect. It is verified once, at the final completion inspection - actions are not graded per step. Every action result reports the independently measured geometry (body count, per-body bounding box, exact volume); read those numbers instead of computing your own - a measured volume that barely moved after a cut, or an envelope that shrank after a boss, tells you exactly what went wrong. Optional `expectedEffects` are informational self-checks: a mismatch reports the measured value and never undoes your work. The inspector counts only native `HoleFeature` holes for a `holes` check; assert extrude-cut holes with a `feature` check on `ExtrudeFeature` (count only - `expectedSizeMm` is measurable only for fillets and chamfers). Keep material separate from appearance, and never delete-and-rebuild history outside the approved destructive-rebuild strategy. To finish, run one `inspect_fusion` requesting every plan `fusion_effect` check; when all pass, mark the component done with `update_plan`.

## Lay features out without interference, and verify it visually

Passing every scalar check does not make a good part: body-count, volume, and bounding box cannot see that two features overlap in space. Before you place a feature, budget the plate into distinct regions and give each feature group its own: a 60 mm boss centred at the origin occupies a 30 mm radius, so a PCB pocket or a hole row must stay clear of that disc; cooling slots and a vent-hole grid must not share the same strip; every hole must clear part edges and its neighbours. Compute positions from the plate size and the feature sizes, not by eye.

Then confirm it with your eyes. Include a `visual-evidence` check in the plan, and when you inspect - and always once the geometry is built, before material and appearance - request that check so the inspector renders the multi-view sheet and hands it back as pixels. Read the top view: if the boss cuts into the pocket, a slot crosses the vent holes, or anything looks crowded or malformed, fix it. Delete_owned the offending feature and rebuild it at coordinates that give it clear space - do this yourself, without asking. A scalar inspection stays camera-still and cheap; only a visual-evidence inspection renders views, so ask for pixels when you actually need to look.

## Repair your own work

Only a structurally broken result - a non-parametric history, no solid body, or violated manual intent - is undone automatically. Everything else is kept for targeted repair, so act on the measured feedback: a wrong body count means a reused profile split the solid or a boss did not join; a volume far from intent means a swallowed face or an overshooting cut; a missing feature means the profile cut nothing. Repair before building on top: `delete_owned` the offending feature (or its sketch) in a new action and rebuild it correctly; `delete_owned` removes only what Chamfer created this session, never user history. When an action deletes or replaces a body or feature you created earlier, declare that entity in `affectedReferences` so intent-preservation knows the change is deliberate.

```python
# Revise an earlier feature: remove your own, then rebuild it correctly.
delete_owned(boss_extrude)   # accepts only features/sketches/bodies you registered
```
