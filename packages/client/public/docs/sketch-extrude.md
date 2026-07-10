# Sketch and Extrude

Use `BuildSketch` when a profile combines several 2D operations.
Create the sketch on an explicit plane, then extrude the resulting face in `BuildPart`.

```python
from build123d import *

# --- params ---
width = 60  # [20, 120] Plate width in mm
height = 40  # [20, 100] Plate height in mm
thickness = 6  # [2, 20] Plate thickness in mm
# --- end params ---

with BuildPart() as plate:
    with BuildSketch(Plane.XY):
        Rectangle(width, height)
    extrude(amount=thickness)

result = plate.part
```

For a symmetric extrusion, use half the total thickness in each direction.

```python
with BuildPart() as centered:
    with BuildSketch(Plane.XY):
        Circle(20)
    extrude(amount=10, both=True)
result = centered.part
```

Use `Locations` to repeat sketch geometry without manually transforming each shape.

```python
with BuildSketch(Plane.XY) as pattern:
    with Locations((-20, 0), (20, 0)):
        Circle(5)
```

Keep all operations inside the matching builder context, or use the algebra API consistently.
Assign the final shape to `result`.
