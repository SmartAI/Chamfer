# Common Tracebacks

## `NameError`

The script omitted an import or refers to a variable before assignment.
Every tool call is a fresh namespace, so each script must import build123d and recreate all geometry.

```python
from build123d import *
result = Box(10, 20, 30)
```

## `ValueError: Cannot find a solid to operate on`

A subtractive operation ran before a base solid existed, or outside its `BuildPart` context.
Create the additive body first and keep the cut inside the same builder.

## Fillet or chamfer construction failure

The radius is too large, the selected edge set is unsuitable, or earlier booleans produced tiny edges.
Reduce the radius and filter a smaller geometric edge set.

## Boolean produced an empty or invalid result

Check operand placement and dimensions.
Avoid coincident faces and zero-thickness intersections.
Extend subtractive tools through the target by a small margin.

## `AttributeError` on selectors

Do not guess method names from other CAD libraries.
Common build123d selectors include `edges()`, `faces()`, `filter_by(...)`, `sort_by(...)`, and `group_by(...)`.
Call `lookup_docs` for the operation family and rewrite the complete script.

## Missing `result`

The final top-level variable must be named exactly `result`.

```python
with BuildPart() as model:
    Box(30, 20, 10)
result = model.part
```
