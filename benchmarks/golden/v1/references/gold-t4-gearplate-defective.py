# DELIBERATELY DEFECTIVE variant of GOLD-T4-GEARPLATE: the o-ring groove is
# missing and only the 30-degree dowel is drilled (the 135-degree dowel is
# missing). Discrimination fixture - the oracle must FAIL exactly:
# dowels (1 != 2), dowel-135deg (0 != 1), groove-inner, groove-outer.
# Everything else (including volume, which stays inside the band) must pass.
# Run via oracle.py to re-validate discrimination.
import math
import sys

from build123d import (
    Align,
    Box,
    BuildPart,
    Cylinder,
    GeomType,
    Hole,
    Locations,
    Mode,
    PolarLocations,
    export_step,
    fillet,
)

PLATE_D, PLATE_T = 140, 15
SEAT_D, SEAT_DEPTH = 47, 9
THRU_D = 37
BOLT_BCD, BOLT_N, BOLT_D = 120, 6, 9
DOWEL_D, DOWEL_BCD = 5, 100
CUT_X0, CUT_X1, CUT_Y = 10, 40, -45
FILLET_R = 6


def build():
    with BuildPart() as p:
        Cylinder(PLATE_D / 2, PLATE_T, align=(Align.CENTER, Align.CENTER, Align.MIN))
        with Locations((0, 0, PLATE_T)):
            Hole(SEAT_D / 2, depth=SEAT_DEPTH)
        Hole(THRU_D / 2)
        with PolarLocations(BOLT_BCD / 2, BOLT_N, start_angle=90):
            Hole(BOLT_D / 2)
        # DEFECT: only the 30-degree dowel; no o-ring groove.
        a = math.radians(30)
        with Locations((DOWEL_BCD / 2 * math.cos(a), DOWEL_BCD / 2 * math.sin(a), 0)):
            Hole(DOWEL_D / 2)
        with Locations((CUT_X0, -80, 0)):
            Box(CUT_X1 - CUT_X0, 80 + CUT_Y, PLATE_T, align=(Align.MIN, Align.MIN, Align.MIN), mode=Mode.SUBTRACT)
        corners = [
            e
            for e in p.edges().filter_by(GeomType.LINE)
            if abs(e.center().Y - CUT_Y) < 1e-6 and (abs(e.center().X - CUT_X0) < 1e-6 or abs(e.center().X - CUT_X1) < 1e-6)
        ]
        fillet(corners, FILLET_R)
    return p.part


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "/tmp/gold-t4-gearplate-defective.step"
    part = build()
    print("volume mm3:", part.volume)
    export_step(part, out)
    print("exported:", out)
