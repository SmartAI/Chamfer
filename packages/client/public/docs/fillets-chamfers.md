# Fillets and Chamfers

Apply edge treatments after the main solid and cuts are stable.
Select edges by geometry and orientation instead of relying on list positions.

```python
from build123d import *

# --- params ---
length = 60  # [20, 120] Block length in mm
radius = 4  # [1, 12] Edge fillet radius in mm
# --- end params ---

with BuildPart() as body:
    Box(length, 30, 12)
    vertical_edges = body.edges().filter_by(Axis.Z)
    fillet(vertical_edges, radius=radius)

result = body.part
```

Use `chamfer` similarly.

```python
with BuildPart() as plate:
    Box(50, 30, 8)
    top_edges = plate.edges().group_by(Axis.Z)[-1]
    chamfer(top_edges, length=1.5)
result = plate.part
```

If a fillet fails, reduce the radius or treat fewer edges.
The radius must fit between nearby faces and must not consume a thin wall.
Perform large booleans before fillets because later cuts can invalidate rounded topology.
