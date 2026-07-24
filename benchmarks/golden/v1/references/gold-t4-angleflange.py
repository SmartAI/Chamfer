# Reference build for GOLD-T4-ANGLEFLANGE (tier 4, multi-axis).
# A 45-degree flanged adapter: flange A flat on Z=0, a straight barrel along
# the 45-degree axis (in XZ, toward +X+Z), flange B normal to that axis with
# back/front faces 60/70 mm along it, a 28 mm bore through the whole assembly,
# and a bolt pattern on each flange (A: along Z; B: along the barrel axis).
# Must score 100% with oracle.py.
# Run: py-tests/.venv/bin/python gold-t4-angleflange.py [out.step]
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

S = math.sqrt(2) / 2
AXIS = (S, 0, S)  # 45 degrees in XZ

FLANGE_A_D, FLANGE_A_T = 90, 12
FLANGE_A_BOLT_D, FLANGE_A_BCD = 9, 74  # holes at 45/135/225/315 deg from +X
BARREL_D = 40
FLANGE_B_D = 70
FLANGE_B_BACK_S, FLANGE_B_FRONT_S = 60, 70  # along the axis from the origin
FLANGE_B_BOLT_D, FLANGE_B_BCD = 7, 54
BORE_D = 28


def on_axis(s):
    return (s * S, 0, s * S)


def build():
    with BuildPart() as p:
        Cylinder(FLANGE_A_D / 2, FLANGE_A_T, align=(Align.CENTER, Align.CENTER, Align.MIN))
        with Locations(Plane(origin=(0, 0, 0), z_dir=AXIS)):
            Cylinder(
                BARREL_D / 2,
                FLANGE_B_BACK_S,
                align=(Align.CENTER, Align.CENTER, Align.MIN),
            )
        with Locations(Plane(origin=on_axis(FLANGE_B_BACK_S), z_dir=AXIS)):
            Cylinder(
                FLANGE_B_D / 2,
                FLANGE_B_FRONT_S - FLANGE_B_BACK_S,
                align=(Align.CENTER, Align.CENTER, Align.MIN),
            )
        # Trim everything below Z=0 so flange A's bottom face stays flat.
        Box(400, 400, 100, align=(Align.CENTER, Align.CENTER, Align.MAX), mode=Mode.SUBTRACT)
        # Through bore along the barrel axis, exiting flange A's bottom face.
        with Locations(Plane(origin=on_axis(-30), z_dir=AXIS)):
            Cylinder(
                BORE_D / 2,
                130,
                align=(Align.CENTER, Align.CENTER, Align.MIN),
                mode=Mode.SUBTRACT,
            )
        # Flange A bolt holes (along Z, bounded so they cannot touch the barrel or flange B).
        c = FLANGE_A_BCD / 2 * S  # 26.163
        with Locations((c, c, 0), (c, -c, 0), (-c, c, 0), (-c, -c, 0)):
            Hole(FLANGE_A_BOLT_D / 2, depth=30)
        # Flange B bolt holes (along the axis), pattern datum: two on +/-Y, two in XZ.
        u = (S, 0, -S)  # in-plane direction within XZ
        v = (0, 1, 0)
        mid = on_axis((FLANGE_B_BACK_S + FLANGE_B_FRONT_S) / 2)
        r = FLANGE_B_BCD / 2
        for off in (u, tuple(-x for x in u), v, tuple(-x for x in v)):
            origin = tuple(m + r * o for m, o in zip(mid, off))
            with Locations(Plane(origin=origin, z_dir=AXIS)):
                Hole(FLANGE_B_BOLT_D / 2, depth=10)
    return p.part


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "/tmp/gold-t4-angleflange.step"
    part = build()
    print("volume mm3:", part.volume)
    export_step(part, out)
    print("exported:", out)
