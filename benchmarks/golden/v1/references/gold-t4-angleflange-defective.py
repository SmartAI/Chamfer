# DELIBERATELY DEFECTIVE variant of GOLD-T4-ANGLEFLANGE: the whole barrel /
# flange B assembly is built at 30 degrees instead of 45. Discrimination
# fixture proving the oracle grades the multi-axis angle - it must FAIL:
# dimensions (bbox changes), flange-b-faces (plane nz = cos30 = 0.866 falls
# outside [0.65, 0.76]), and both flange-a-hole position checks (the bbox
# center shifts). Existence checks (barrel/flange-b/bore cylinders, hole
# counts) still pass. Run via oracle.py to re-validate discrimination.
import math
import sys

from build123d import (
    Align,
    Box,
    BuildPart,
    Cylinder,
    Hole,
    Locations,
    Mode,
    Plane,
    export_step,
)

ANGLE = math.radians(30)  # DEFECT: should be 45 degrees
AX = (math.sin(ANGLE), 0, math.cos(ANGLE))
U = (math.cos(ANGLE), 0, -math.sin(ANGLE))

FLANGE_A_D, FLANGE_A_T = 90, 12
FLANGE_A_BOLT_D, FLANGE_A_BCD = 9, 74
BARREL_D = 40
FLANGE_B_D = 70
FLANGE_B_BACK_S, FLANGE_B_FRONT_S = 60, 70
FLANGE_B_BOLT_D, FLANGE_B_BCD = 7, 54
BORE_D = 28


def on_axis(s):
    return tuple(s * a for a in AX)


def build():
    with BuildPart() as p:
        Cylinder(FLANGE_A_D / 2, FLANGE_A_T, align=(Align.CENTER, Align.CENTER, Align.MIN))
        with Locations(Plane(origin=(0, 0, 0), z_dir=AX)):
            Cylinder(BARREL_D / 2, FLANGE_B_BACK_S, align=(Align.CENTER, Align.CENTER, Align.MIN))
        with Locations(Plane(origin=on_axis(FLANGE_B_BACK_S), z_dir=AX)):
            Cylinder(
                FLANGE_B_D / 2,
                FLANGE_B_FRONT_S - FLANGE_B_BACK_S,
                align=(Align.CENTER, Align.CENTER, Align.MIN),
            )
        Box(400, 400, 100, align=(Align.CENTER, Align.CENTER, Align.MAX), mode=Mode.SUBTRACT)
        with Locations(Plane(origin=on_axis(-30), z_dir=AX)):
            Cylinder(BORE_D / 2, 130, align=(Align.CENTER, Align.CENTER, Align.MIN), mode=Mode.SUBTRACT)
        c = FLANGE_A_BCD / 2 * math.sqrt(2) / 2
        with Locations((c, c, 0), (c, -c, 0), (-c, c, 0), (-c, -c, 0)):
            Hole(FLANGE_A_BOLT_D / 2, depth=30)
        v = (0, 1, 0)
        mid = on_axis((FLANGE_B_BACK_S + FLANGE_B_FRONT_S) / 2)
        r = FLANGE_B_BCD / 2
        for off in (U, tuple(-x for x in U), v, tuple(-x for x in v)):
            origin = tuple(m + r * o for m, o in zip(mid, off))
            with Locations(Plane(origin=origin, z_dir=AX)):
                Hole(FLANGE_B_BOLT_D / 2, depth=10)
    return p.part


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "/tmp/gold-t4-angleflange-defective.step"
    part = build()
    print("volume mm3:", part.volume)
    export_step(part, out)
    print("exported:", out)
