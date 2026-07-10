# Selectors and Measurements

Chamfer automatically measures the final `result` after each successful run.
The tool returns:

- `bboxMm`: overall X, Y, and Z extents in millimetres.
- `volumeMm3`: solid volume.
- `areaMm2`: surface area.
- `children`: per-child bounding boxes and volumes for compounds.

Use those numbers to verify requested dimensions before claiming success.
If the user asks for an 80 mm wide part, the first `bboxMm` value should be close to 80 unless the requested coordinate system says otherwise.

Use selectors to target edge and face operations.
Do not rely on list indexes unless the geometry is trivial.

```python
from build123d import *

# --- params ---
width = 70  # [30, 140] Block width in mm
depth = 40  # [20, 100] Block depth in mm
height = 16  # [4, 60] Block height in mm
edge_radius = 3  # [1, 8] Vertical edge fillet radius in mm
# --- end params ---

with BuildPart() as body:
    Box(width, depth, height)
    vertical_edges = body.edges().filter_by(Axis.Z)
    fillet(vertical_edges, radius=edge_radius)

result = body.part
```

Common selector patterns:

```python
vertical_edges = part.edges().filter_by(Axis.Z)
top_face = part.faces().sort_by(Axis.Z)[-1]
bottom_face = part.faces().sort_by(Axis.Z)[0]
x_aligned_faces = part.faces().filter_by(Axis.X)
```

For top or bottom features, select the face explicitly and place the feature on it.

```python
with BuildPart() as mount:
    Box(80, 50, 10)
    with Locations(mount.faces().sort_by(Axis.Z)[-1]):
        Hole(4)
result = mount.part
```

For compounds, label child shapes when possible so returned child measurements are easier to inspect.

```python
left = Box(20, 20, 10).translate((-15, 0, 0))
left.label = "left_block"
right = Box(20, 20, 10).translate((15, 0, 0))
right.label = "right_block"
result = Compound(children=[left, right])
```

Measurement checks catch many visual mistakes.
Compare the overall bounding box, component count, and child bounding boxes with the prompt after every successful run.
