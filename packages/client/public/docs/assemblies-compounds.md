# Assemblies and Compounds

Use a fused `Part` when the result is one manufactured solid.
Use a `Compound` when distinct components must remain separate.

```python
from build123d import *

# --- params ---
gap = 8  # [2, 30] Gap between blocks in mm
# --- end params ---

left = Box(20, 20, 10).translate((-(10 + gap / 2), 0, 0))
right = Box(20, 20, 10).translate((10 + gap / 2, 0, 0))
result = Compound(children=[left, right])
```

Position components with `translate`, `rotate`, or a `Location` before making the compound.

```python
base = Box(60, 40, 6)
post = Cylinder(5, 30).translate((0, 0, 6))
result = base + post
```

Boolean union is appropriate only when solids overlap with real volume.
Do not fuse components separated by a gap or touching only at a point.
For compounds, inspect child bounding boxes and labels in the returned measurements.
