# Allowed build123d API

Chamfer runs each script in Pyodide with build123d and OCP.wasm.
Return geometry through the top-level `result` variable.
Do not export files or call interactive viewers.

```python
from build123d import *

# --- params ---
width = 80  # [20, 200] Body width in mm
depth = 50  # [20, 160] Body depth in mm
height = 12  # [2, 60] Body height in mm
# --- end params ---

result = Box(width, depth, height)
```

Stable imports come from build123d.
Use Python standard library modules only for small calculations, for example `math.sin` or `math.radians`.
Do not import third-party packages, OCP internals, viewer packages, or file-system helpers.

The commonly supported modeling surface is:

- Builders: `BuildPart`, `BuildSketch`, `BuildLine`.
- Solids: `Box`, `Cylinder`, `Sphere`, `Cone`, `Torus`, `Wedge`.
- Sketch objects: `Circle`, `Rectangle`, `RectangleRounded`, `Ellipse`, `RegularPolygon`, `SlotArc` (arc, height), `SlotCenterToCenter`, `SlotOverall`, `Trapezoid`, `Triangle` (keyword-only: any three of sides a, b, c and angles A, B, C).
- Curves: `Line`, `Polyline`, `CenterArc`, `RadiusArc`, `SagittaArc` (start, end, sagitta), `ThreePointArc`, `TangentArc`, `Spline`, `Bezier` (*points), `Helix`.
- Operations: `extrude`, `revolve`, `loft`, `sweep`, `fillet`, `chamfer`, `offset`, `split`, `mirror`, `add`, `make_face`.
- Holes: `Hole`, `CounterBoreHole`, `CounterSinkHole`.
- Placement: `Locations`, `GridLocations`, `PolarLocations`, `HexLocations`, `Location`, `Plane`, `Axis`.
- Enums and selectors: `Mode`, `Align`, `Keep`, `Select`, `Unit` (MM, CM, M, IN, FT), `edges()`, `faces()`, `solids()`, `filter_by(...)`, `sort_by(...)`, `group_by(...)`.
- Shape composition: `+`, `-`, `&`, `translate(...)`, `rotate(...)`, `Compound(children=[...])`.

Prefer builder code when making a single solid with many features.
Prefer algebra when combining already named shapes.
Do not mix styles inside a small feature unless it makes the model clearer.

### Complete minimal builder

```python
from build123d import *

# --- params ---
plate_width = 90  # [30, 180] Plate width in mm
plate_depth = 50  # [20, 120] Plate depth in mm
plate_thickness = 8  # [2, 30] Plate thickness in mm
hole_diameter = 6.5  # [2, 12] Mounting hole diameter in mm
# --- end params ---

hole_x = plate_width / 2 - 12
hole_y = plate_depth / 2 - 12

with BuildPart() as plate:
    Box(plate_width, plate_depth, plate_thickness)
    with Locations((-hole_x, -hole_y), (-hole_x, hole_y), (hole_x, -hole_y), (hole_x, hole_y)):
        Hole(hole_diameter / 2)

result = plate.part
```

If a traceback says an operation or selector does not exist, stop guessing.
Look up the matching topic, then rewrite the complete script.
