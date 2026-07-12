import math

from build123d import Align, Axis, Box, BuildPart, Hole, Locations, Plane


# A 6 mm-deep Hole from a plane 2 mm under the top surface: it drills BOTH
# ways from that plane, so only ~2+3=5... measure instead of guessing.
with BuildPart() as buried:
    Box(20.0, 20.0, 10.0, align=(Align.CENTER, Align.CENTER, Align.MIN))
    with Locations(Plane.XY.offset(8.0)):
        Hole(radius=2.0, depth=6.0)
removed_buried = 20.0 * 20.0 * 10.0 - buried.part.volume

# The same Hole from the real top face removes exactly a 6 mm-deep bore.
with BuildPart() as surfaced:
    Box(20.0, 20.0, 10.0, align=(Align.CENTER, Align.CENTER, Align.MIN))
    with Locations(Plane(surfaced.faces().sort_by(Axis.Z)[-1])):
        Hole(radius=2.0, depth=6.0)
removed_surfaced = 20.0 * 20.0 * 10.0 - surfaced.part.volume

assert abs(removed_surfaced - math.pi * 2.0**2 * 6.0) < 0.5
# The buried variant removed a different amount: the plane's position leaked
# into the geometry. Never drill a blind hole from a plane inside the body.
assert abs(removed_buried - removed_surfaced) > 1.0
result = surfaced.part
