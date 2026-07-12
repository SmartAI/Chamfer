# Minimal probe for a failing sweep. Run this pattern (with the real path and
# profile) before rewriting a model: it proves the framing facts one at a time.
from build123d import Circle, Plane, Spline, sweep


path = Spline((0.0, 0.0, 0.0), (30.0, 0.0, 10.0), (60.0, 15.0, 12.0))
print("start point:", path @ 0)
print("start tangent:", path % 0)
print("end point:", path @ 1)

profile_plane = Plane(origin=path @ 0, z_dir=path % 0)
print("profile plane origin:", profile_plane.origin)

profile = profile_plane * Circle(3.0)
result = sweep(profile, path=path)
print("solids:", len(result.solids()))
print("bbox:", result.bounding_box().size)
assert len(result.solids()) == 1
