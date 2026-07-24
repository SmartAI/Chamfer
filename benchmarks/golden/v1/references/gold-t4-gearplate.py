# Reference build for GOLD-T4-GEARPLATE (tier 4).
# Derived values the case prompt makes the agent compute:
#   through bore d = seat 47 - 2*5 shoulder = 37
#   o-ring groove OD = ID 60 + 2*4 width = 68
#   dowel centers from angle+PCD: (50*cos30, 50*sin30), (50*cos135, 50*sin135)
#   cutout fillet centers: (CUT_X0-6, -39), (CUT_X1+6, -39)
# Must score 100% with oracle.py.
# Run: py-tests/.venv/bin/python gold-t4-gearplate.py [out.step]
import math
import sys

from build123d import (
    Align,
    Box,
    BuildPart,
    BuildSketch,
    Circle,
    Cylinder,
    GeomType,
    Hole,
    Locations,
    Mode,
    Plane,
    PolarLocations,
    export_step,
    extrude,
    fillet,
)

PLATE_D, PLATE_T = 140, 15
SEAT_D, SEAT_DEPTH = 47, 9
SHOULDER_W = 5
THRU_D = SEAT_D - 2 * SHOULDER_W  # derived: 37
BOLT_D, BOLT_BCD, BOLT_N = 9, 120, 6  # one hole on +Y
DOWEL_D, DOWEL_BCD = 5, 100
DOWEL_ANGLES = (30, 135)  # degrees CCW from +X
GROOVE_ID, GROOVE_W, GROOVE_DEPTH = 60, 4, 2.5  # OD derived: 68
CUT_X0, CUT_X1, CUT_Y = 10, 40, -45  # side walls at X=10/40, inner wall at Y=-45
FILLET_R = 6


def build():
    with BuildPart() as p:
        Cylinder(PLATE_D / 2, PLATE_T, align=(Align.CENTER, Align.CENTER, Align.MIN))
        # Stepped center bore: seat from the top face, derived through bore below.
        with Locations((0, 0, PLATE_T)):
            Hole(SEAT_D / 2, depth=SEAT_DEPTH)
        Hole(THRU_D / 2)
        # Bolt circle, one hole on +Y.
        with PolarLocations(BOLT_BCD / 2, BOLT_N, start_angle=90):
            Hole(BOLT_D / 2)
        # Asymmetric dowel holes.
        dowels = [
            (DOWEL_BCD / 2 * math.cos(math.radians(a)), DOWEL_BCD / 2 * math.sin(math.radians(a)), 0)
            for a in DOWEL_ANGLES
        ]
        with Locations(*dowels):
            Hole(DOWEL_D / 2)
        # O-ring groove in the bottom face.
        with BuildSketch(Plane.XY):
            Circle(GROOVE_ID / 2 + GROOVE_W)
            Circle(GROOVE_ID / 2, mode=Mode.SUBTRACT)
        extrude(amount=GROOVE_DEPTH, mode=Mode.SUBTRACT)
        # Rectangular side cutout, open to the rim on -Y, walls X=10/40, inner wall Y=-45.
        with Locations((CUT_X0, -80, 0)):
            Box(CUT_X1 - CUT_X0, 80 + CUT_Y, PLATE_T, align=(Align.MIN, Align.MIN, Align.MIN), mode=Mode.SUBTRACT)
        # Fillet the cutout's two inner vertical corners.
        corners = [
            e
            for e in p.edges().filter_by(GeomType.LINE)
            if abs(e.center().Y - CUT_Y) < 1e-6 and (abs(e.center().X - CUT_X0) < 1e-6 or abs(e.center().X - CUT_X1) < 1e-6)
        ]
        fillet(corners, FILLET_R)
    return p.part


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "/tmp/gold-t4-gearplate.step"
    part = build()
    print("volume mm3:", part.volume)
    export_step(part, out)
    print("exported:", out)
