# Reference build for GOLD-T1B-LBRACKET (tier 1).
# Used to validate the case's expected values; must score 100% with oracle.py.
# Run: py-tests/.venv/bin/python gold-t1b-lbracket.py [out.step]
import sys

from build123d import (
    Align,
    Box,
    BuildPart,
    Hole,
    Locations,
    Plane,
    export_step,
)

BASE_LEN = 60  # X, horizontal base leg length
WIDTH = 40  # Y, both legs
BASE_THK = 8  # Z, base leg thickness
LEG_THK = 8  # X, vertical leg thickness
HEIGHT = 50  # Z, overall height
HOLE_D = 6
BASE_HOLE_FROM_FREE_END = 15  # -> hole X = 60 - 15 = 45
SIDE_EDGE_OFFSET = 8  # -> hole Y = +/-12
UPRIGHT_HOLE_BELOW_TOP = 12  # -> hole Z = 50 - 12 = 38


def build():
    with BuildPart() as p:
        Box(BASE_LEN, WIDTH, BASE_THK, align=(Align.MIN, Align.CENTER, Align.MIN))
        Box(LEG_THK, WIDTH, HEIGHT, align=(Align.MIN, Align.CENTER, Align.MIN))
        hx = BASE_LEN - BASE_HOLE_FROM_FREE_END
        hy = WIDTH / 2 - SIDE_EDGE_OFFSET
        # Two vertical through holes in the base leg.
        with Locations((hx, hy, 0), (hx, -hy, 0)):
            Hole(HOLE_D / 2)
        # Two horizontal (along X) through holes in the vertical leg.
        hz = HEIGHT - UPRIGHT_HOLE_BELOW_TOP
        with Locations(
            Plane(origin=(0, hy, hz), z_dir=(1, 0, 0)),
            Plane(origin=(0, -hy, hz), z_dir=(1, 0, 0)),
        ):
            Hole(HOLE_D / 2)
    return p.part


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "/tmp/gold-t1b-lbracket.step"
    part = build()
    print("volume mm3:", part.volume)
    export_step(part, out)
    print("exported:", out)
