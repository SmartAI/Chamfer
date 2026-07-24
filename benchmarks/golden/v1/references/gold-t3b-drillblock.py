# Reference build for GOLD-T3B-DRILLBLOCK (tier 3).
# Used to validate the case's expected values; must score 100% with oracle.py.
# Run: py-tests/.venv/bin/python gold-t3b-drillblock.py [out.step]
import sys

from build123d import (
    Align,
    Box,
    BuildPart,
    CounterBoreHole,
    GeomType,
    Hole,
    Locations,
    Plane,
    chamfer,
    export_step,
)

L, W, H = 80, 50, 40  # X, Y, Z
MAIN_D = 12  # through passage along X at Y=0, Z=20
MAIN_Z = 20
VERT_D = 10  # blind passage from top center
VERT_DEPTH = 30  # floor at Z = 10, crossing the main passage
MNT_D = 7
CB_D = 11
CB_DEPTH = 6
MNT_X, MNT_Y = 30, 17  # from block center
CHAM = 2  # top-face perimeter chamfer


def build():
    with BuildPart() as p:
        Box(L, W, H, align=(Align.CENTER, Align.CENTER, Align.MIN))
        # Main passage: through along X.
        with Locations(Plane(origin=(0, 0, MAIN_Z), z_dir=(1, 0, 0))):
            Hole(MAIN_D / 2)
        # Vertical blind passage from the top face center, intersecting the main passage.
        with Locations((0, 0, H)):
            Hole(VERT_D / 2, depth=VERT_DEPTH)
        # Four counterbored mounting holes, through the full height.
        with Locations((MNT_X, MNT_Y, H), (MNT_X, -MNT_Y, H), (-MNT_X, MNT_Y, H), (-MNT_X, -MNT_Y, H)):
            CounterBoreHole(MNT_D / 2, CB_D / 2, CB_DEPTH)
        # 2 mm chamfers on the four straight perimeter edges of the top face.
        top_lines = [
            e
            for e in p.edges().filter_by(GeomType.LINE)
            if abs(e.center().Z - H) < 1e-6
        ]
        chamfer(top_lines, CHAM)
    return p.part


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "/tmp/gold-t3b-drillblock.step"
    part = build()
    print("volume mm3:", part.volume)
    export_step(part, out)
    print("exported:", out)
