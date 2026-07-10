# Holes and Counterbores

Create holes inside `BuildPart` while a face or workplane is active.
Use `Locations` for repeated hole centers.

```python
from build123d import *

# --- params ---
plate_width = 80  # [40, 160] Plate width in mm
hole_diameter = 6  # [2, 14] Through-hole diameter in mm
# --- end params ---

with BuildPart() as plate:
    Box(plate_width, 50, 8)
    with Locations((-30, -15), (-30, 15), (30, -15), (30, 15)):
        Hole(hole_diameter / 2)

result = plate.part
```

`CounterBoreHole` and `CounterSinkHole` anchor at the active workplane and cut
downward from it, unlike `Hole`, which through-cuts in both directions.
Locate them on the face that should carry the bore; on the default mid-solid
`Plane.XY` workplane the counterbore would sink into the middle of the part
and remove the whole top half. Dimensions are radii where the API requests radius.

```python
with BuildPart() as mount:
    Box(50, 30, 10)
    with Locations(mount.faces().sort_by(Axis.Z)[-1]):
        CounterBoreHole(radius=3, counter_bore_radius=6, counter_bore_depth=3)
result = mount.part
```

For a countersunk fastener, use `CounterSinkHole(radius=..., counter_sink_radius=...)`.
Ensure a blind-hole depth is less than the available material thickness.
Inspect both top and bottom views to confirm hole count and placement.
