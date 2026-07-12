from build123d import Align, Box, Location, Plane


# --- v1, gate-passed: L-bracket (base plate + back wall), unchanged ---
base = Box(60.0, 40.0, 6.0, align=(Align.CENTER, Align.CENTER, Align.MIN))
# Wall along the back edge (y 14..20), buried 1 mm into the base (z 5..36).
wall = Location((0.0, 17.0, 5.0)) * Box(60.0, 6.0, 31.0, align=(Align.CENTER, Align.CENTER, Align.MIN))
bracket_v1 = base + wall

# --- v2: the ONLY surgical change is this slot through the base plate ---
slot = Plane.XY.offset(-1.0) * Box(20.0, 10.0, 8.0, align=(Align.CENTER, Align.CENTER, Align.MIN))
result = bracket_v1 - slot

# Collateral-damage alarms: envelope and wall untouched, delta as predicted.
assert tuple(result.bounding_box().size) == tuple(bracket_v1.bounding_box().size)
predicted_removed = 20.0 * 10.0 * 6.0  # slot cross-section times base thickness
assert abs((bracket_v1.volume - result.volume) - predicted_removed) < 1e-6
assert len(result.solids()) == 1
