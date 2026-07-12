# Real thread geometry, for when the user explicitly needs it (printed or
# visual threads). A bead profile swept along a Helix, fused onto the core.
# This is expensive; for ordinary fasteners model a nominal cylinder instead.
from build123d import Align, Circle, Cylinder, Helix, Plane, sweep


pitch = 1.25
turns = 4
core = Cylinder(3.4, pitch * turns, align=(Align.CENTER, Align.CENTER, Align.MIN))
path = Helix(pitch=pitch, height=pitch * turns, radius=3.5)
# Same framing rule as any sweep: profile at the path start, normal to it.
profile = Plane(origin=path @ 0, z_dir=path % 0) * Circle(0.55)
thread = sweep(profile, path=path, is_frenet=True)
result = core + thread

assert len(result.solids()) == 1
assert result.volume > core.volume
