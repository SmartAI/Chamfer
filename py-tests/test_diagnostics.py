import pathlib
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).parent.parent / "packages/client/public/py"))
import harness

PLATE_WITH_HOLES = """
from build123d import *
with BuildPart() as p:
    Box(80, 50, 8)
    with Locations((30, 15), (-30, 15), (30, -15), (-30, -15)):
        Hole(radius=3.25)
result = p.part
"""

BLIND_POCKET = """
from build123d import *
# Pocket open at the top face (z=4), floor at z=-2: blind, 6 mm deep.
result = Box(40, 40, 8) - Pos(0, 0, 1) * Cylinder(radius=5, height=6)
"""

TWO_APART = """
from build123d import *
a = Box(10, 10, 10); a.label = "left"
b = Pos(11, 0, 0) * Box(10, 10, 10); b.label = "right"
result = Compound(children=[a, b])
"""

TWO_TOUCHING = """
from build123d import *
a = Box(10, 10, 10); a.label = "left"
b = Pos(10, 0, 0) * Box(10, 10, 10); b.label = "right"
result = Compound(children=[a, b])
"""

TWO_OVERLAPPING = """
from build123d import *
a = Box(10, 10, 10); a.label = "left"
b = Pos(8, 0, 6) * Box(10, 10, 10); b.label = "right"
result = Compound(children=[a, b])
"""


def measure(source: str) -> dict:
    return harness.run_script(source)["measurements"]


# ---------- topology counts ----------

def test_box_topology_counts():
    topo = measure("from build123d import *\nresult = Box(10, 20, 30)")["topology"]
    assert topo == {"faces": 6, "edges": 12, "vertices": 8, "shells": 1}


def test_topology_counts_survive_holes():
    topo = measure(PLATE_WITH_HOLES)["topology"]
    assert topo["faces"] == 6 + 4  # box faces plus one cylinder wall per hole
    assert topo["shells"] == 1


# ---------- hole census ----------

def test_through_holes_are_detected():
    holes = measure(PLATE_WITH_HOLES)["holes"]
    assert len(holes) == 4
    for hole in holes:
        assert hole["kind"] == "through"
        assert hole["diameterMm"] == pytest.approx(6.5)
        assert hole["depthMm"] == pytest.approx(8.0)
        assert hole["axisDir"] == pytest.approx([0, 0, 1])
    centers = sorted(tuple(round(c) for c in h["centerMm"]) for h in holes)
    assert centers == [(-30, -15, 0), (-30, 15, 0), (30, -15, 0), (30, 15, 0)]


def test_blind_pocket_is_detected_as_blind():
    holes = measure(BLIND_POCKET)["holes"]
    assert len(holes) == 1
    assert holes[0]["kind"] == "blind"
    assert holes[0]["diameterMm"] == pytest.approx(10.0)
    assert holes[0]["depthMm"] == pytest.approx(6.0)


def test_boss_is_not_a_hole():
    boss = """
from build123d import *
result = Box(40, 40, 8) + Pos(0, 0, 7) * Cylinder(radius=5, height=6)
"""
    assert measure(boss)["holes"] == []


def test_convex_fillet_is_not_a_hole():
    filleted = """
from build123d import *
b = Box(40, 40, 8)
result = fillet(b.edges().filter_by(Axis.Z), radius=4)
"""
    assert measure(filleted)["holes"] == []


def test_counterbore_reports_both_diameters_as_through():
    counterbore = """
from build123d import *
with BuildPart() as p:
    Box(40, 40, 10)
    with Locations(p.part.faces().sort_by(Axis.Z)[-1]):
        CounterBoreHole(radius=3, counter_bore_radius=6, counter_bore_depth=3)
result = p.part
"""
    holes = measure(counterbore)["holes"]
    diameters = sorted(round(h["diameterMm"], 3) for h in holes)
    assert diameters == [6.0, 12.0]
    # The narrow bore exits the bottom; the counterbore opens into the bore:
    # both count as through at assembly level.
    assert all(h["kind"] == "through" for h in holes)


# ---------- clearance matrix ----------

def clearance_of(source: str) -> dict:
    entries = measure(source)["clearances"]
    assert len(entries) == 1
    return entries[0]


def test_apart_children_report_distance():
    entry = clearance_of(TWO_APART)
    assert entry["a"] == "left" and entry["b"] == "right"
    assert entry["state"] == "apart"
    assert entry["distanceMm"] == pytest.approx(1.0)


def test_touching_children_report_touching():
    assert clearance_of(TWO_TOUCHING)["state"] == "touching"


def test_overlapping_children_report_overlap_volume():
    entry = clearance_of(TWO_OVERLAPPING)
    assert entry["state"] == "interpenetrating"
    assert entry["overlapMm3"] == pytest.approx(80.0, rel=1e-6)


def test_single_body_has_no_clearances_key():
    m = measure("from build123d import *\nresult = Box(10, 20, 30)")
    assert "clearances" not in m


def test_diagnostics_failure_is_fail_open(monkeypatch):
    def boom(shape):
        raise RuntimeError("synthetic diagnostics bug")

    monkeypatch.setattr(harness, "_hole_census", boom)
    monkeypatch.setattr(harness, "_topology_counts", boom)
    m = measure(PLATE_WITH_HOLES)
    assert "holes" not in m and "topology" not in m
    assert m["volumeMm3"] > 0  # the run itself is unharmed
