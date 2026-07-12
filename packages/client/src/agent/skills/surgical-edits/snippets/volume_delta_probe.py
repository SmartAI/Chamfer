# Predict-then-verify probe for an edit: compute the volume the edit should
# add or remove BEFORE running the full model, then hold the edit to it.
from build123d import Align, Box, Cylinder, Plane


before = Box(50.0, 30.0, 8.0, align=(Align.CENTER, Align.CENTER, Align.MIN))

# The planned edit: one 6 mm-diameter through hole.
cutter = Plane.XY.offset(-1.0) * Cylinder(3.0, 10.0, align=(Align.CENTER, Align.CENTER, Align.MIN))
predicted_removed = 3.141592653589793 * 3.0**2 * 8.0  # bore through 8 mm

after = before - cutter
actual_removed = before.volume - after.volume
print("predicted:", round(predicted_removed, 3), "actual:", round(actual_removed, 3))
assert abs(actual_removed - predicted_removed) < 0.5
# Envelope unchanged: a feature edit must not move or scale the part.
assert tuple(before.bounding_box().size) == tuple(after.bounding_box().size)
result = after
