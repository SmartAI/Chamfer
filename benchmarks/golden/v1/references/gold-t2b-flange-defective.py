# DELIBERATELY DEFECTIVE variant of GOLD-T2B-FLANGE: only the two +/-X bolt
# holes are drilled; the +/-Y pair is missing. Discrimination fixture - the
# oracle must FAIL exactly: bolt-holes (2 != 4) and bolt-holes-y (0 != 2).
# All other checks (including volume, which stays inside the +/-2.5% band)
# must still pass. Run via oracle.py to re-validate discrimination.
import sys

from build123d import (
    Align,
    BuildPart,
    Cylinder,
    Hole,
    Locations,
    export_step,
)

DISC_D = 100
DISC_T = 10
BOSS_D = 50
BOSS_H = 15
BORE_D = 25
BOLT_D = 8
BOLT_CIRCLE_D = 75


def build():
    with BuildPart() as p:
        Cylinder(DISC_D / 2, DISC_T, align=(Align.CENTER, Align.CENTER, Align.MIN))
        with Locations((0, 0, DISC_T)):
            Cylinder(BOSS_D / 2, BOSS_H, align=(Align.CENTER, Align.CENTER, Align.MIN))
        Hole(BORE_D / 2)
        # DEFECT: only 2 of the 4 bolt holes.
        with Locations((BOLT_CIRCLE_D / 2, 0, 0), (-BOLT_CIRCLE_D / 2, 0, 0)):
            Hole(BOLT_D / 2)
    return p.part


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "/tmp/gold-t2b-flange-defective.step"
    part = build()
    print("volume mm3:", part.volume)
    export_step(part, out)
    print("exported:", out)
