# DELIBERATELY DEFECTIVE variant of GOLD-T3B-DRILLBLOCK: the four mounting
# holes are plain through holes (no counterbores) and the top-face perimeter
# chamfers are missing. Discrimination fixture - the oracle must FAIL exactly:
# counterbores (0 != 4) and top-chamfers (0 < 4). mount-holes must still pass
# (spanMm [30, 41] deliberately tolerates both the counterbored 34 mm span and
# the plain 40 mm span; the counterbore check owns cb discrimination), and the
# volume stays inside the +/-2.5% band. Run via oracle.py to re-validate.
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

L, W, H = 80, 50, 40
MAIN_D = 12
MAIN_Z = 20
VERT_D = 10
VERT_DEPTH = 30
MNT_D = 7
MNT_X, MNT_Y = 30, 17


def build():
    with BuildPart() as p:
        Box(L, W, H, align=(Align.CENTER, Align.CENTER, Align.MIN))
        with Locations(Plane(origin=(0, 0, MAIN_Z), z_dir=(1, 0, 0))):
            Hole(MAIN_D / 2)
        with Locations((0, 0, H)):
            Hole(VERT_D / 2, depth=VERT_DEPTH)
        # DEFECT: plain holes, no counterbores; and no top chamfers.
        with Locations((MNT_X, MNT_Y, H), (MNT_X, -MNT_Y, H), (-MNT_X, MNT_Y, H), (-MNT_X, -MNT_Y, H)):
            Hole(MNT_D / 2)
    return p.part


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "/tmp/gold-t3b-drillblock-defective.step"
    part = build()
    print("volume mm3:", part.volume)
    export_step(part, out)
    print("exported:", out)
