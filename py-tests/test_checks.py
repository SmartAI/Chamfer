import pathlib
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).parent.parent / "packages/client/public/py"))
import harness

BOX_BODY = """
from build123d import *
result = Box(10, 20, 30)
"""

EXPECT_BOX = '# --- expect ---\nEXPECT = {"bodies": 1, "bbox_mm": [10, 20, 30]}\n# --- end expect ---\n'


def with_checks(checks_literal: str, body: str = BOX_BODY, expect: str = EXPECT_BOX) -> str:
    return f"{expect}# --- checks ---\nCHECKS = {checks_literal}\n# --- end checks ---\n{body}"


def gate_of(source: str) -> dict:
    return harness.run_script(source)["gate"]


def agent_checks(gate: dict) -> list:
    return [c for c in gate["checks"] if c["name"].startswith("check:")]


# ---------- parse_checks ----------

def test_absent_block_returns_none():
    assert harness.parse_checks(BOX_BODY) is None


def test_valid_block_normalizes():
    specs = harness.parse_checks(
        with_checks('[{"kind": "hole_through", "diameter": 6.5, "count": 4}]')
    )
    assert specs == [{"kind": "hole_through", "diameter": 6.5, "tol": 0.5, "count": 4}]


def test_block_without_assignment_raises():
    src = "# --- checks ---\nx = 1\n# --- end checks ---\n" + BOX_BODY
    with pytest.raises(ValueError, match="CHECKS"):
        harness.parse_checks(src)


def test_non_list_raises():
    with pytest.raises(ValueError, match="list"):
        harness.parse_checks(with_checks('{"kind": "bbox"}'))


def test_unknown_kind_raises():
    with pytest.raises(ValueError, match="unknown kind"):
        harness.parse_checks(with_checks('[{"kind": "teleport"}]'))


def test_missing_required_key_raises():
    with pytest.raises(ValueError, match="missing keys"):
        harness.parse_checks(with_checks('[{"kind": "clearance", "a": "x", "b": "y"}]'))


def test_unknown_key_raises():
    with pytest.raises(ValueError, match="unknown keys"):
        harness.parse_checks(
            with_checks('[{"kind": "volume", "range_mm3": [1, 2], "colour": "red"}]')
        )


@pytest.mark.parametrize(
    "entry",
    [
        '{"kind": "hole_through", "diameter": -1, "count": 1}',
        '{"kind": "hole_through", "diameter": 5, "count": -1}',
        '{"kind": "hole_through", "diameter": 5, "count": [1, 2]}',
        '{"kind": "clearance", "a": "", "b": "y", "min_mm": 1}',
        '{"kind": "clearance", "a": "x", "b": "y", "min_mm": -0.5}',
        '{"kind": "bbox", "size_mm": [1, 2]}',
        '{"kind": "bbox", "size_mm": [1, 2, 0]}',
        '{"kind": "volume", "range_mm3": [2, 1]}',
        '{"kind": "count_faces", "count": [2, 1]}',
        '{"kind": "count_faces", "count": 1.5}',
        '{"kind": "symmetric", "plane": "AB"}',
        '{"kind": "symmetric", "plane": "XY", "tol_pct": 0}',
        '"not a dict"',
    ],
)
def test_invalid_entries_raise(entry):
    with pytest.raises(ValueError, match=r"CHECKS\[0\]"):
        harness.parse_checks(with_checks(f"[{entry}]"))


def test_too_many_checks_raises():
    entries = ", ".join(['{"kind": "count_faces", "count": 6}'] * 33)
    with pytest.raises(ValueError, match="at most"):
        harness.parse_checks(with_checks(f"[{entries}]"))


def test_count_range_is_accepted():
    specs = harness.parse_checks(with_checks('[{"kind": "count_faces", "count": [6, 10]}]'))
    assert specs[0]["count"] == [6, 10]


# ---------- gate integration ----------

def test_gate_without_checks_block_is_unchanged():
    gate = gate_of(EXPECT_BOX + BOX_BODY)
    assert gate["status"] == "passed"
    assert all(not c["name"].startswith("check") for c in gate["checks"])
    assert "checks_block" not in {c["name"] for c in gate["checks"]}


def test_malformed_checks_block_fails_gate():
    gate = gate_of(with_checks('[{"kind": "warp", "factor": 9}]'))
    assert gate["status"] == "failed"
    block = next(c for c in gate["checks"] if c["name"] == "checks_block")
    assert not block["passed"]
    assert "unknown kind" in block["detail"]


def test_passing_checks_pass_the_gate():
    gate = gate_of(
        with_checks(
            '[{"kind": "count_faces", "count": 6}, {"kind": "count_edges", "count": [10, 14]},'
            ' {"kind": "bbox", "size_mm": [30, 10, 20]}, {"kind": "volume", "range_mm3": [5900, 6100]},'
            ' {"kind": "symmetric", "plane": "XY"}]'
        )
    )
    assert gate["status"] == "passed"
    assert len(agent_checks(gate)) == 5


def test_failing_check_fails_gate_even_when_expect_passes():
    gate = gate_of(with_checks('[{"kind": "count_faces", "count": 7}]'))
    assert gate["status"] == "failed"
    check = agent_checks(gate)[0]
    assert not check["passed"]
    assert "expected 7, found 6" in check["detail"]


def test_checks_run_even_when_expect_block_is_missing():
    gate = gate_of(with_checks('[{"kind": "count_faces", "count": 6}]', expect=""))
    assert gate["status"] == "failed"  # missing expect block still fails
    assert agent_checks(gate)[0]["passed"]


PLATE = """
from build123d import *
with BuildPart() as p:
    Box(80, 50, 8)
    with Locations((30, 15), (-30, 15), (30, -15), (-30, -15)):
        Hole(radius=3.25)
result = p.part
"""

PLATE_ONE_BLIND = """
from build123d import *
with BuildPart() as p:
    Box(80, 50, 8)
    with Locations((30, 15), (-30, 15), (30, -15)):
        Hole(radius=3.25)
result = p.part - Pos(-30, -15, 1) * Cylinder(radius=3.25, height=6)
"""

HOLE_CHECK = '[{"kind": "hole_through", "diameter": 6.5, "count": 4}]'
PLATE_EXPECT = '# --- expect ---\nEXPECT = {"bodies": 1, "bbox_mm": [80, 50, 8]}\n# --- end expect ---\n'


def test_hole_through_check_passes_on_four_through_holes():
    gate = gate_of(with_checks(HOLE_CHECK, body=PLATE, expect=PLATE_EXPECT))
    assert gate["status"] == "passed"


def test_hole_through_check_fails_when_one_hole_is_blind():
    gate = gate_of(with_checks(HOLE_CHECK, body=PLATE_ONE_BLIND, expect=PLATE_EXPECT))
    assert gate["status"] == "failed"
    check = agent_checks(gate)[0]
    assert not check["passed"]
    assert "expected 4, found 3" in check["detail"]
    assert "1 blind" in check["detail"]


def test_hole_blind_check_counts_blind_holes():
    gate = gate_of(
        with_checks(
            '[{"kind": "hole_blind", "diameter": 6.5, "count": 1}]',
            body=PLATE_ONE_BLIND,
            expect=PLATE_EXPECT,
        )
    )
    assert gate["status"] == "passed"


ASSEMBLY_EXPECT = '# --- expect ---\nEXPECT = {"bodies": 2, "bbox_mm": [21, 10, 10]}\n# --- end expect ---\n'

ASSEMBLY_APART = """
from build123d import *
a = Box(10, 10, 10); a.label = "left"
b = Pos(11, 0, 0) * Box(10, 10, 10); b.label = "right"
result = Compound(children=[a, b])
"""

ASSEMBLY_OVERLAP = """
from build123d import *
a = Box(10, 10, 10); a.label = "left"
b = Pos(9, 0, 0) * Box(10, 10, 10); b.label = "right"
result = Compound(children=[a, b])
"""


def test_clearance_check_passes_for_separated_parts():
    gate = gate_of(
        with_checks(
            '[{"kind": "clearance", "a": "left", "b": "right", "min_mm": 0.5}]',
            body=ASSEMBLY_APART,
            expect=ASSEMBLY_EXPECT,
        )
    )
    assert agent_checks(gate)[0]["passed"]


def test_clearance_check_fails_for_interpenetrating_parts():
    gate = gate_of(
        with_checks(
            '[{"kind": "clearance", "a": "left", "b": "right", "min_mm": 0.0}]',
            body=ASSEMBLY_OVERLAP,
            expect=ASSEMBLY_EXPECT,
        )
    )
    check = agent_checks(gate)[0]
    assert not check["passed"]
    assert "interpenetrating" in check["detail"]


def test_unknown_label_fails_with_available_labels():
    gate = gate_of(
        with_checks(
            '[{"kind": "clearance", "a": "left", "b": "lid", "min_mm": 0.1}]',
            body=ASSEMBLY_APART,
            expect=ASSEMBLY_EXPECT,
        )
    )
    check = agent_checks(gate)[0]
    assert not check["passed"]
    assert "'lid'" in check["detail"] and "left" in check["detail"]


# Five disjoint bodies, coordinate-symmetric about both YZ (x -> -x) and
# XZ (y -> -y): three plates centered on the Z axis plus a spacer pair at
# x = +-25. Mirror-differencing the Compound child-by-child trips OCC's
# coincident-face booleans and used to report ~150% "asymmetric" volume.
SYMMETRIC_STACK = """
from build123d import *
plate1 = Pos(0, 0, 4) * Box(80, 40, 8)
plate2 = Pos(0, 0, 23) * Box(80, 40, 6)
plate3 = Pos(0, 0, 40) * Box(80, 40, 4)
sp1 = Pos(25, 0, 14) * Cylinder(radius=5, height=12)
sp2 = Pos(-25, 0, 14) * Cylinder(radius=5, height=12)
result = Compound(children=[plate1, plate2, plate3, sp1, sp2])
"""

STACK_EXPECT = '# --- expect ---\nEXPECT = {"bodies": 5, "bbox_mm": [80, 40, 42]}\n# --- end expect ---\n'


def test_symmetric_check_passes_for_symmetric_multibody_compound():
    gate = gate_of(
        with_checks(
            '[{"kind": "symmetric", "plane": "YZ"}, {"kind": "symmetric", "plane": "XZ"}]',
            body=SYMMETRIC_STACK,
            expect=STACK_EXPECT,
        )
    )
    checks = agent_checks(gate)
    assert [c["passed"] for c in checks] == [True, True], [c["detail"] for c in checks]


def test_symmetric_check_fails_for_asymmetric_multibody_compound():
    # Same stack with one spacer pulled off-center: XZ symmetry survives,
    # YZ symmetry is broken.
    body = SYMMETRIC_STACK.replace("Pos(25, 0, 14)", "Pos(15, 0, 14)")
    gate = gate_of(
        with_checks(
            '[{"kind": "symmetric", "plane": "YZ"}, {"kind": "symmetric", "plane": "XZ"}]',
            body=body,
            expect='# --- expect ---\nEXPECT = {"bodies": 5, "bbox_mm": [80, 40, 42]}\n# --- end expect ---\n',
        )
    )
    checks = agent_checks(gate)
    assert not checks[0]["passed"], checks[0]["detail"]
    assert "asymmetric volume" in checks[0]["detail"]
    assert checks[1]["passed"], checks[1]["detail"]


def test_symmetric_check_fails_for_asymmetric_part():
    asymmetric = """
from build123d import *
result = Box(10, 10, 10) + Pos(7, 0, 0) * Box(4, 4, 4)
"""
    gate = gate_of(
        with_checks(
            '[{"kind": "symmetric", "plane": "YZ"}]',
            body=asymmetric,
            expect='# --- expect ---\nEXPECT = {"bodies": 1, "bbox_mm": [14, 10, 10]}\n# --- end expect ---\n',
        )
    )
    check = agent_checks(gate)[0]
    assert not check["passed"]
    assert "asymmetric volume" in check["detail"]


def test_check_evaluator_crash_fails_that_check_only(monkeypatch):
    def boom(spec, holes):
        raise RuntimeError("synthetic check bug")

    monkeypatch.setattr(harness, "_eval_hole_check", boom)
    gate = gate_of(
        with_checks(
            '[{"kind": "hole_through", "diameter": 6.5, "count": 4},'
            ' {"kind": "count_faces", "count": 6}]'
        )
    )
    checks = agent_checks(gate)
    assert not checks[0]["passed"]
    assert "check evaluator failed" in checks[0]["detail"]
    assert checks[1]["passed"]  # the sibling check still evaluated
