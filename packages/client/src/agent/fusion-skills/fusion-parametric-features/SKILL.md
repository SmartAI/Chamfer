---
name: fusion-parametric-features
version: 1.12.0
description: Author reliable native Autodesk Fusion features - parameters, sketches, extrudes, holes, cuts, fillets, chamfers, patterns, and material and appearance assignment - inside the run_fusion_action harness. Load before constructing or changing parametric Fusion geometry. Covers the harness contract, the sandbox policy that rejects a body before it runs, and verified API recipes (including the participant-body rule that stops a Through-All cut from failing with "body not found" on a plane coincident with a boundary face, and material/appearance lookup by substring across the installed libraries). Pair with fusion-verification-and-repair for the completion contract, layout verification, and repair.
---

# Fusion parametric features

## The harness transaction

Your `run_fusion_action` body runs inside a Fusion command transaction that already binds `design`, `root`, `references`, `action`, `transaction`, and `materialLibraries`. Never acquire the Application, active document, or UI, and never define `run()` - the harness owns the one-Undo transaction.

## Sandbox policy

The body is statically checked before running; a rejection modifies nothing - fix the exact violation and retry. To pass:

- Import `adsk.core` and `adsk.fusion` explicitly; unimported `adsk.*` use is rejected as an ambient capability.
- Call Fusion constructors and methods by full path every time, e.g. `adsk.core.ValueInput.createByString("20 mm")`. Storing and reusing a call's RESULT is fine; aliasing the callable itself (`P = adsk.core.Point3D.create; P(...)`) is rejected.
- Callable by bare name only: your own `def` functions, `register_entity`, and pure builtins (`range`, `len`, `abs`, `min`, `max`, `round`, `sum`, `enumerate`, `sorted`, `reversed`, `list`, `dict`, `set`, `tuple`, `str`, `int`, `float`, `bool`, `isinstance`, `zip`, `all`, `any`).
- Denied members (never read or call): `activeDocument`, `activeProduct`, `activeViewport`, `documents`, `save`, `close`, `deleteMe` (unless the strategy is destructive-rebuild), `commandDefinitions`, `executeTextCommand`, and any dunder.
- Allowed statements: assignment, `if`, `for`, `try`, `def`, comprehensions, `import`. `while`, `with`, `class`, `lambda`, walrus `:=`, and decorators are rejected.

## Units, identity, and selection

Fusion works in centimetres. Pass user lengths as unit-bearing strings (`"52 mm"`) or as named-parameter expressions (`"base_thk"`, `"base_thk / 2"`) so Fusion converts them. Raw sketch points are in cm (160 mm = 16 cm; centred rectangles use half-extents).

Call `register_entity(entity, "kind:name")` for every parameter, sketch, feature, body, and component you create. Select edges and faces by inspecting geometry (line direction, plane normal, centroid), never by index - indices shift as topology changes. Consult `search_fusion_docs` for any unfamiliar signature.

Build every feature from its own fresh sketch on a construction plane: one drawn profile (`item(0)`), a datum-aligned normal, unambiguous direction. A face-attached sketch has two traps - the face boundary becomes a competing profile (`item(0)` can be the whole face), and the normal may point into the solid, burying a boss below the plate. Prefer an offset plane at the face height (see the boss recipe); if you must sketch on a face, pick the profile whose `areaProperties().area` matches what you drew and confirm the direction.

## Traps that waste retries

In an empty design leave `affectedReferences` empty - there is no prior geometry, and an unresolvable reference fails the whole action.

A sketch needs no dimensions or constraints: shapes at explicit `Point3D` coordinates are already located. Skip `SketchDimensions` and `geometricConstraints` unless the user asks - they add signature errors, nothing to the solid.

Every join or cut must set `input.participantBodies = [target_solid]` and drive the extent one-sided toward the body. With the extent symmetric or the participant unset, a Through-All cut sketched on a plane coincident with a boundary face throws `RuntimeError: body not found to extrude through` - Fusion looks away from the solid and finds nothing. Reserve `SymmetricExtentDirection` for a sketch plane inside the solid.

Through-All overshoots in a hollow part: it does not stop at the near wall - it pierces the far wall too, silently changing the envelope, volume, and a prior feature (watch the measured volume drop). To pierce one wall or flange, drive a one-sided distance extent equal to that thickness (`setDistanceExtent(False, "flange_thk")` toward the solid), never Through-All. Place hole centres on the solid rim, not over the open cavity - a hole whose profile sits over empty space removes zero material, so the hole count stays zero; confirm each centre's `worldGeometry` lands inside the flange footprint.

Never edit a prior feature's extent in place: `setOneSideExtent`/`extentOne` on an existing extrude fails inside the action transaction (`invalid argument taperAngle`) - `delete_owned` it and rebuild. `setPositionByPoint` hole placement on a raised boss face throws `InternalValidationError (logicalSelection)`; place holes by sketch points (`setPositionBySketchPoints`) or cut the bore as an extrude.

A Join fuses only where the new material OVERLAPS the target - touching is not enough. A boss, rib, or gusset whose base sits exactly on a boundary face can come back as a SEPARATE body, visible as a wrong measured body count. Guarantee the union: start the feature a hair inside the target - offset the sketch plane ~1 mm into the solid, or extrude a hair back into it as well as out (`setTwoSidesDistanceExtent(out, "1 mm")`) - and always set `participantBodies = [target_solid]`. Never rely on a just-touching interface to fuse.

## Build the part one feature per action

Each `run_fusion_action` is one coherent feature-level change - one native Undo step. Build in dependency order: base solid, then each boss, hole set, pocket, pattern, fillet, chamfer, then material, then appearance. Read the measured geometry each action returns before starting the next. Load fusion-verification-and-repair for the completion contract, interference-free layout, visual verification, and repair.

## Verified recipes

```python
import adsk.core
import adsk.fusion

# Named parameters (reference them later by name inside expressions).
design.userParameters.add("base_thk", adsk.core.ValueInput.createByString("18 mm"), "mm", "Base thickness")

# Sketch on a construction plane. cm units: a 160 x 70 mm centred rectangle => half-extents 8.0 x 3.5.
base_sketch = root.sketches.add(root.xYConstructionPlane)
base_sketch.sketchCurves.sketchLines.addCenterPointRectangle(
    adsk.core.Point3D.create(0, 0, 0), adsk.core.Point3D.create(8.0, 3.5, 0))
base_sketch.sketchCurves.sketchCircles.addByCenterRadius(adsk.core.Point3D.create(0, 0, 0), 4.8)
register_entity(base_sketch, "sketch:base")

# Extrude a profile. New body / join / cut all share createInput -> configure -> add.
extrudes = root.features.extrudeFeatures
base_input = extrudes.createInput(base_sketch.profiles.item(0),
    adsk.fusion.FeatureOperations.NewBodyFeatureOperation)
base_input.setDistanceExtent(False, adsk.core.ValueInput.createByString("base_thk"))
base_extrude = extrudes.add(base_input)
register_entity(base_extrude, "feature:ExtrudeFeature:base")
solid = base_extrude.bodies.item(0)
register_entity(solid, "body:housing")

# BOSS / pad on top of a plate: sketch on an OFFSET construction plane at the
# top-face height, NOT on the face itself. A face-attached sketch has two traps -
# it also exposes the whole face as a competing profile (item(0) can be the plate
# top), and its normal may point into the solid so a positive extrude drives the
# boss DOWN through the plate. An offset plane from xY has a clean +Z normal and a
# single drawn profile, so both the profile and the direction are unambiguous.
planes = root.constructionPlanes
plane_input = planes.createInput()
plane_input.setByOffset(root.xYConstructionPlane, adsk.core.ValueInput.createByString("plate_thickness"))
boss_plane = planes.add(plane_input)
boss_sketch = root.sketches.add(boss_plane)
boss_sketch.sketchCurves.sketchCircles.addByCenterRadius(adsk.core.Point3D.create(0, 0, 0), 3.0)
register_entity(boss_sketch, "sketch:boss")
# Join (adds material) and Cut (removes material). ALWAYS set participantBodies so
# Fusion knows which solid to modify - see "Traps that waste retries".
# Extrude out by boss_height AND a hair (1 mm) back into the plate: that overlap
# fuses the boss into one body. A boss that only TOUCHES the top face can return as
# a separate body and fail body-count.
boss_input = extrudes.createInput(boss_sketch.profiles.item(0), adsk.fusion.FeatureOperations.JoinFeatureOperation)
boss_input.participantBodies = [solid]
boss_input.setTwoSidesDistanceExtent(
    adsk.core.ValueInput.createByString("boss_height"), adsk.core.ValueInput.createByString("1 mm"))
register_entity(extrudes.add(boss_input), "feature:ExtrudeFeature:boss")

# Cut several hole profiles at once: gather them into one ObjectCollection.
hole_profiles = adsk.core.ObjectCollection.create()
for i in range(hole_sketch.profiles.count):
    hole_profiles.add(hole_sketch.profiles.item(i))
cut_input = extrudes.createInput(hole_profiles, adsk.fusion.FeatureOperations.CutFeatureOperation)
cut_input.participantBodies = [solid]
# Sketch on the base plane, block on +Z -> cut positive (toward the body), not symmetric.
cut_input.setAllExtent(adsk.fusion.ExtentDirections.PositiveExtentDirection)
register_entity(extrudes.add(cut_input), "feature:ExtrudeFeature:mount_holes")

# ANY plane other than ground XY (xZ, yZ, offset planes, faces). TRAP: sketch axes
# map to world axes with per-plane sign flips - a circle guessed at sketch Y=+4.5
# lands at world Z=-45 mm outside the block ("body not found"), and a flange
# rectangle guessed onto a yZ-offset plane extruded 80 mm outside its housing.
# Never hand-map the axes: state the intended WORLD millimetres, convert with the
# harness helper world_to_sketch(sketch, x_mm, y_mm, z_mm), and confirm one drawn
# point's worldGeometry before creating the feature. Extrude DIRECTION on such
# planes is equally guess-prone: when the plane normal's sign is uncertain, place
# the plane at the feature's mid-depth and use a symmetric extent (as this
# through-bore does), or extrude two-sided so one side always overlaps the solid.
bore_sketch = root.sketches.add(root.xZConstructionPlane)
centre = world_to_sketch(bore_sketch, 0, 0, 45)   # intended world (0, 0, 45 mm)
bore_sketch.sketchCurves.sketchCircles.addByCenterRadius(centre, 2.5)
bore_input = extrudes.createInput(bore_sketch.profiles.item(0), adsk.fusion.FeatureOperations.CutFeatureOperation)
bore_input.participantBodies = [solid]
bore_input.setDistanceExtent(True, adsk.core.ValueInput.createByString("block_y"))
register_entity(extrudes.add(bore_input), "feature:ExtrudeFeature:bore")

# Pick edges by geometry: the four vertical (Z-parallel) edges of the base.
verticals = adsk.core.ObjectCollection.create()
for i in range(solid.edges.count):
    edge = solid.edges.item(i)
    g = edge.geometry
    if g.objectType == adsk.core.Line3D.classType():
        v = g.endPoint.asVector(); v.subtract(g.startPoint.asVector())
        if abs(v.z) > 1e-6 and abs(v.x) < 1e-6 and abs(v.y) < 1e-6:
            verticals.add(edge)

# Fillet and chamfer consume an ObjectCollection of edges.
fillets = root.features.filletFeatures
fin = fillets.createInput()
fin.addConstantRadiusEdgeSet(verticals, adsk.core.ValueInput.createByString("6 mm"), True)
register_entity(fillets.add(fin), "feature:FilletFeature:corners")

chamfers = root.features.chamferFeatures
cin = chamfers.createInput2()
cin.chamferEdgeSets.addEqualDistanceChamferEdgeSet(top_edges, adsk.core.ValueInput.createByString("2 mm"), False)
register_entity(chamfers.add(cin), "feature:ChamferFeature:top")

# Material and appearance are independent. Resolve each by case-insensitive substring
# across the bound materialLibraries - never hard-code a library index. In the stock
# libraries this finds material "Aluminum ..." in "Fusion Material Library" and the
# appearance "Aluminum - Anodized Glossy (Blue)" in "Fusion Appearance Library".
picked_material = None
for li in range(materialLibraries.count):
    mats = materialLibraries.item(li).materials
    for mi in range(mats.count):
        if picked_material is None and "aluminum" in mats.item(mi).name.lower():
            picked_material = mats.item(mi)
if picked_material is not None:
    solid.material = picked_material
picked_appearance = None
for li in range(materialLibraries.count):
    apps = materialLibraries.item(li).appearances
    for ai in range(apps.count):
        nm = apps.item(ai).name.lower()
        if picked_appearance is None and "blue" in nm and "anodiz" in nm:
            picked_appearance = apps.item(ai)
if picked_appearance is not None:
    solid.appearance = picked_appearance
```

