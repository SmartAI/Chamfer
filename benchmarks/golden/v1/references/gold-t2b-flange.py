# Reference build for GOLD-T2B-FLANGE (tier 2).
# Used to validate the case's expected values; must score 100% with oracle.py.
# Run: py-tests/.venv/bin/python gold-t2b-flange.py [out.step]
import sys

from build123d import (
    Align,
    BuildPart,
    Cylinder,
    Hole,
    Locations,
    PolarLocations,
    export_step,
)

DISC_D = 100
DISC_T = 10
BOSS_D = 50
BOSS_H = 15  # above the disc top face; total height 25
BORE_D = 25
BOLT_D = 8
BOLT_CIRCLE_D = 75
BOLT_COUNT = 4  # one on each of +X, +Y, -X, -Y


def build():
    with BuildPart() as p:
        Cylinder(DISC_D / 2, DISC_T, align=(Align.CENTER, Align.CENTER, Align.MIN))
        with Locations((0, 0, DISC_T)):
            Cylinder(BOSS_D / 2, BOSS_H, align=(Align.CENTER, Align.CENTER, Align.MIN))
        Hole(BORE_D / 2)  # through the full 25 mm height
        with PolarLocations(BOLT_CIRCLE_D / 2, BOLT_COUNT):
            Hole(BOLT_D / 2)  # through the 10 mm disc (only disc material out there)
    return p.part


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "/tmp/gold-t2b-flange.step"
    part = build()
    print("volume mm3:", part.volume)
    export_step(part, out)
    print("exported:", out)
