# Minimal probe for a placement problem. Print the frame facts before moving
# anything: plane origin and normal, then the bounding boxes of both parts.
from build123d import Align, Axis, Box, Cylinder, Plane


body = Box(30.0, 20.0, 12.0, align=(Align.CENTER, Align.CENTER, Align.MIN))
face = body.faces().sort_by(Axis.Z)[-1]
plane = Plane(face)
print("plane origin:", plane.origin)
print("plane normal:", plane.z_dir)

candidate = plane * Cylinder(4.0, 6.0, align=(Align.CENTER, Align.CENTER, Align.MIN))
print("body bbox:", body.bounding_box())
print("candidate bbox:", candidate.bounding_box())

result = body + candidate
print("solids after fuse:", len(result.solids()))
assert len(result.solids()) == 1
