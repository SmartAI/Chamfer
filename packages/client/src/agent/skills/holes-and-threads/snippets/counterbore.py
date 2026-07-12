from build123d import Align, Axis, Box, BuildPart, CounterBoreHole, Locations, Plane
import math


with BuildPart() as part:
    Box(30.0, 30.0, 10.0, align=(Align.CENTER, Align.CENTER, Align.MIN))
    # Drill from the entry (top) face so the counterbore sits on it.
    with Locations(Plane(part.faces().sort_by(Axis.Z)[-1])):
        CounterBoreHole(radius=2.25, counter_bore_radius=4.0, counter_bore_depth=4.0)
result = part.part

plate = 30.0 * 30.0 * 10.0
bore = math.pi * 2.25**2 * 6.0
counter_bore = math.pi * 4.0**2 * 4.0
assert abs(plate - result.volume - (bore + counter_bore)) < 0.5
assert len(result.solids()) == 1
