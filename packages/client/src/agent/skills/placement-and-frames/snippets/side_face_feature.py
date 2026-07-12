from build123d import Align, Axis, Box, Cylinder, Plane


body = Box(30.0, 20.0, 12.0, align=(Align.CENTER, Align.CENTER, Align.MIN))
# The front face (smallest Y) supplies the frame; its normal points outward.
front = Plane(body.faces().sort_by(Axis.Y)[0])
# Start 1 mm inside the body so the peg fuses instead of merely touching.
peg = front.offset(-1.0) * Cylinder(3.0, 9.0, align=(Align.CENTER, Align.CENTER, Align.MIN))
result = body + peg

assert len(result.solids()) == 1
assert result.bounding_box().min.Y < body.bounding_box().min.Y - 7.0
