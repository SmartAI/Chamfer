---
name: placement-and-frames
description: Place parts and sketches deliberately with Plane, Location, and Align, and verify placement numerically. Load before assembling any multi-part model, or when a part lands in the wrong place, floats, interpenetrates, or a clearance check fails.
---

## When to reach for this

Use this whenever more than one body must sit in a precise relationship: bosses on plates, pegs in holes, lids on boxes, features on side faces.
Placement mistakes are the root cause behind most "floating part" and clearance failures.

## Invariants

- Sketch coordinates are local to their workplane. A `Plane` maps local XY into the world; never read a sketch's numbers as global coordinates, and never "fix" a misplaced body by guessing a translate.
- `align` decides where a primitive sits relative to its own origin, per axis: `Align.MIN`, `Align.CENTER`, `Align.MAX`. A body whose bottom must rest on Z=0 is `align=(Align.CENTER, Align.CENTER, Align.MIN)`. Set it explicitly whenever a datum matters.
- Build workplanes from real geometry, not from remembered numbers: `Plane(part.faces().sort_by(Axis.Z)[-1])` follows the model when a dimension changes; a hand-typed `Plane(origin=(0, 0, 10))` silently breaks.
- `Plane.offset(d)` moves a workplane along its own normal. Use it to hover above a face or to bury a joining feature slightly inside the neighbor so the later union is robust.
- Mating parts must share numbers, not coincidences: derive the mate position from the same parameters as the part it touches.
- Verify placement numerically before moving on: `bounding_box().min/.max`, `center()`, and the measurements diagnostics (floating, clearances). Never accept placement by eye.

## Canonical recipes

Datum-controlled stacking - the base owns Z=0, the boss is placed by a face-derived plane, buried 1 mm for a robust fuse:

{{snippet:snippets/align_datum.py}}

A feature on a side face, with the workplane taken from the face itself:

{{snippet:snippets/side_face_feature.py}}

## Failure signatures

- Measurements list a `floating` entry: a part touches nothing. Its placement math is wrong, or it was meant to be fused and is not. Fix the frame; never ignore the entry.
- A clearance check fails with interpenetration nobody asked for: two placements each look right in isolation but disagree about a shared datum. Re-derive both from one parameter.
- A body appears mirrored or on the wrong side of a face: the workplane normal points the other way. Probe `Plane(face).z_dir` before placing, or flip with a negative offset.
- A model is correct until one parameter changes, then features drift apart: placements were hard-coded numbers instead of face- or parameter-derived frames.

## Go deeper

- Probe placement facts one at a time before rewriting: `load_skill("placement-and-frames", resource="snippets/placement_probe.py")`.
- `search_docs` queries: "Plane origin z_dir", "Align enum", "Location arithmetic", "Plane offset".
