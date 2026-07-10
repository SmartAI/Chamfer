# Boolean Operations

Builder-mode primitives add by default.
Use `mode=Mode.SUBTRACT` for cuts and `mode=Mode.INTERSECT` to retain overlap.

```python
from build123d import *

# --- params ---
size = 40  # [20, 100] Body size in mm
wall = 4  # [2, 10] Wall thickness in mm
# --- end params ---

with BuildPart() as open_box:
    Box(size, size, size)
    with Locations((0, 0, wall)):
        Box(size - 2 * wall, size - 2 * wall, size, mode=Mode.SUBTRACT)

result = open_box.part
```

The cut is raised by `wall` so it leaves a floor and extends past the top face
instead of finishing flush with it (see the coincident-face warning below).

The algebra API uses `+`, `-`, and `&` for union, subtraction, and intersection.

```python
outer = Box(50, 40, 10)
slot = Box(20, 10, 10).translate((0, 0, 2))
result = outer - slot
```

Boolean failures usually come from coincident faces, zero-thickness contact, or disconnected operands.
Extend cutting tools slightly beyond the target and avoid features that only touch at one edge or point.
Check the resulting bounding box and volume after every significant boolean.
