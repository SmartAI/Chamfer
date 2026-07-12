from build123d import Align, Axis, Box, Cylinder, Plane


base = Box(40.0, 30.0, 10.0, align=(Align.CENTER, Align.CENTER, Align.MIN))
# Workplane from the real top face, sunk 1 mm so the boss overlaps the base.
top = Plane(base.faces().sort_by(Axis.Z)[-1]).offset(-1.0)
boss = top * Cylinder(8.0, 7.0, align=(Align.CENTER, Align.CENTER, Align.MIN))
result = base + boss

assert abs(result.bounding_box().min.Z) < 1e-6
assert abs(result.bounding_box().max.Z - 16.0) < 1e-6
assert len(result.solids()) == 1
