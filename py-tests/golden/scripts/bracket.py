# --- params ---
leg_length = 60  # [30, 120] Leg length in mm
leg_width = 30  # [15, 60] Bracket width in mm
thickness = 5  # [3, 10] Wall thickness in mm
hole_diameter = 6  # [3, 10] Mounting hole diameter in mm
# --- end params ---
from build123d import *

with BuildPart() as bracket:
    Box(leg_length, leg_width, thickness, align=(Align.MIN, Align.CENTER, Align.MIN))
    Box(thickness, leg_width, leg_length, align=(Align.MIN, Align.CENTER, Align.MIN))
    with Locations((leg_length - 12, 0, 0)):
        Hole(hole_diameter / 2)
    fillet(bracket.edges().filter_by(Axis.Y).group_by(Axis.X)[0], radius=2)

result = bracket.part
