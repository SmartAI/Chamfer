from build123d import BuildPart, Cylinder, Hole, PolarLocations


with BuildPart() as part:
    Cylinder(30.0, 8.0)
    with PolarLocations(radius=20.0, count=6):
        Hole(2.5)
result = part.part

assert len(result.solids()) == 1
expected_removed = 6 * 3.141592653589793 * 2.5**2 * 8.0
solid_volume = 3.141592653589793 * 30.0**2 * 8.0
assert abs((solid_volume - result.volume) - expected_removed) < 1.0
