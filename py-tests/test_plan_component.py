"""COMPONENT declarations, plan-evidence echo, and the CHECKS vocabulary
extensions that per-component plan gates rely on (targeted hole checks,
hole_internal, clearance max_mm, floating diagnostics)."""
import pathlib
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).parent.parent / "packages/client/public/py"))
import harness

EXPECT_BOX = '# --- expect ---\nEXPECT = {"bodies": 1, "bbox_mm": [10, 20, 30]}\n# --- end expect ---\n'

BOX_BODY = """
from build123d import *
result = Box(10, 20, 30)
"""

# A 20x20x6 plate with a 4 mm bore, and a 3.8 mm pin protruding through it: the
# census probes just past the bore's ends land inside the pin, so the assembly
# sees the bore as occupied (internal) while the plate alone reports through.
PLATE_AND_PIN_BODY = """
from build123d import *
plate = Box(20, 20, 6) - Cylinder(2, 12)
plate.label = "plate"
pin = Cylinder(1.9, 12)
pin.label = "pin"
result = Compound(children=[plate, pin])
"""

EXPECT_PLATE_AND_PIN = (
    '# --- expect ---\nEXPECT = {"bodies": 2, "bbox_mm": [20, 20, 12]}\n# --- end expect ---\n'
)


def run(source: str) -> dict:
    return harness.run_script(source)


def check_by_name(gate: dict, name: str):
    return next((c for c in gate["checks"] if c["name"] == name), None)


# ---------- parse_component ----------


def test_parse_component_absent_returns_none():
    assert harness.parse_component(BOX_BODY) is None


def test_parse_component_accepts_string_list_and_probe():
    assert harness.parse_component('COMPONENT = "lid"\n' + BOX_BODY) == "lid"
    assert harness.parse_component('COMPONENT = ["base", "lid"]\n' + BOX_BODY) == ["base", "lid"]
    assert harness.parse_component('COMPONENT = "probe"\n' + BOX_BODY) == "probe"


@pytest.mark.parametrize(
    "declaration",
    [
        'COMPONENT = "Bad Id"',
        'COMPONENT = ""',
        "COMPONENT = 42",
        "COMPONENT = []",
        'COMPONENT = ["lid", 3]',
        'COMPONENT = ["probe", "lid"]',
    ],
)
def test_parse_component_rejects_malformed(declaration):
    with pytest.raises(ValueError):
        harness.parse_component(declaration + "\n" + BOX_BODY)


def test_malformed_component_fails_the_gate():
    gate = run(EXPECT_BOX + 'COMPONENT = "Bad Id"\n' + BOX_BODY)["gate"]
    entry = check_by_name(gate, "component_block")
    assert entry is not None and entry["passed"] is False
    assert gate["status"] == "failed"


def test_valid_component_adds_no_gate_check():
    gate = run(EXPECT_BOX + 'COMPONENT = "lid"\n' + BOX_BODY)["gate"]
    assert check_by_name(gate, "component_block") is None


# ---------- evidence echo in measurements ----------


def test_run_script_echoes_component_and_raw_checks():
    source = (
        EXPECT_BOX
        + '# --- checks ---\nCHECKS = [{"kind": "bbox", "size_mm": [10, 20, 30]}]\n# --- end checks ---\n'
        + 'COMPONENT = "lid"\n'
        + BOX_BODY
    )
    m = run(source)["measurements"]
    assert m["component"] == "lid"
    assert m["checks"] == [{"kind": "bbox", "size_mm": [10, 20, 30]}]


def test_run_script_omits_echo_when_undeclared():
    m = run(EXPECT_BOX + BOX_BODY)["measurements"]
    assert "component" not in m
    assert "checks" not in m


# ---------- targeted hole checks + hole_internal ----------


def test_untargeted_hole_check_sees_the_occupied_bore_as_not_through():
    source = (
        EXPECT_PLATE_AND_PIN
        + '# --- checks ---\nCHECKS = [{"kind": "hole_through", "diameter": 4, "count": 1}]\n# --- end checks ---\n'
        + PLATE_AND_PIN_BODY
    )
    gate = run(source)["gate"]
    entry = check_by_name(gate, "check:hole_through[0]")
    assert entry["passed"] is False


def test_targeted_hole_check_classifies_by_the_component_alone():
    source = (
        EXPECT_PLATE_AND_PIN
        + '# --- checks ---\nCHECKS = [{"kind": "hole_through", "diameter": 4, "count": 1, "target": "plate"}]\n# --- end checks ---\n'
        + PLATE_AND_PIN_BODY
    )
    gate = run(source)["gate"]
    entry = check_by_name(gate, "check:hole_through[0]")
    assert entry["passed"] is True, entry["detail"]
    assert "in plate" in entry["detail"]


def test_targeted_hole_check_unknown_label_fails():
    source = (
        EXPECT_PLATE_AND_PIN
        + '# --- checks ---\nCHECKS = [{"kind": "hole_through", "diameter": 4, "count": 1, "target": "ghost"}]\n# --- end checks ---\n'
        + PLATE_AND_PIN_BODY
    )
    entry = check_by_name(run(source)["gate"], "check:hole_through[0]")
    assert entry["passed"] is False
    assert "no child labeled" in entry["detail"]


def test_hole_internal_counts_buried_bores():
    # A 4 mm bore drilled through an inner box, then sealed by two cover plates:
    # material past both probe ends -> internal.
    body = """
from build123d import *
core = Box(20, 20, 6) - Cylinder(2, 12)
top = Pos(0, 0, 5) * Box(20, 20, 4)
bottom = Pos(0, 0, -5) * Box(20, 20, 4)
result = core + top + bottom
"""
    source = (
        '# --- expect ---\nEXPECT = {"bodies": 1, "bbox_mm": [20, 20, 14]}\n# --- end expect ---\n'
        + '# --- checks ---\nCHECKS = [{"kind": "hole_internal", "diameter": 4, "count": 1}]\n# --- end checks ---\n'
        + body
    )
    gate = run(source)["gate"]
    entry = check_by_name(gate, "check:hole_internal[0]")
    assert entry["passed"] is True, entry["detail"]


# ---------- clearance max_mm ----------


TOUCHING_PAIR_BODY = """
from build123d import *
a = Box(10, 10, 10)
a.label = "a"
b = Pos(10, 0, 0) * Box(10, 10, 10)
b.label = "b"
result = Compound(children=[a, b])
"""

APART_PAIR_BODY = """
from build123d import *
a = Box(10, 10, 10)
a.label = "a"
b = Pos(15, 0, 0) * Box(10, 10, 10)
b.label = "b"
result = Compound(children=[a, b])
"""


def _clearance_gate(body: str, bbox: str, checks: str) -> dict:
    source = (
        f'# --- expect ---\nEXPECT = {{"bodies": 2, "bbox_mm": {bbox}}}\n# --- end expect ---\n'
        + f"# --- checks ---\nCHECKS = {checks}\n# --- end checks ---\n"
        + body
    )
    return run(source)["gate"]


def test_clearance_max_mm_zero_asserts_touching():
    gate = _clearance_gate(
        TOUCHING_PAIR_BODY, "[20, 10, 10]",
        '[{"kind": "clearance", "a": "a", "b": "b", "min_mm": 0, "max_mm": 0}]',
    )
    assert check_by_name(gate, "check:clearance[0]")["passed"] is True


def test_clearance_max_mm_fails_an_apart_pair():
    gate = _clearance_gate(
        APART_PAIR_BODY, "[25, 10, 10]",
        '[{"kind": "clearance", "a": "a", "b": "b", "min_mm": 0, "max_mm": 0}]',
    )
    entry = check_by_name(gate, "check:clearance[0]")
    assert entry["passed"] is False
    assert "0..0" in entry["detail"]


def test_clearance_range_passes_a_controlled_gap():
    gate = _clearance_gate(
        APART_PAIR_BODY, "[25, 10, 10]",
        '[{"kind": "clearance", "a": "a", "b": "b", "min_mm": 4, "max_mm": 6}]',
    )
    assert check_by_name(gate, "check:clearance[0]")["passed"] is True


def test_clearance_max_mm_below_min_is_rejected():
    gate = _clearance_gate(
        APART_PAIR_BODY, "[25, 10, 10]",
        '[{"kind": "clearance", "a": "a", "b": "b", "min_mm": 2, "max_mm": 1}]',
    )
    entry = check_by_name(gate, "checks_block")
    assert entry["passed"] is False
    assert "max_mm" in entry["detail"]


# ---------- floating diagnostic ----------


def test_floating_lists_children_touching_nothing():
    body = """
from build123d import *
a = Box(10, 10, 10)
a.label = "a"
b = Pos(10, 0, 0) * Box(10, 10, 10)
b.label = "b"
c = Pos(0, 0, 30) * Box(5, 5, 5)
c.label = "c"
result = Compound(children=[a, b, c])
"""
    m = run(EXPECT_BOX.replace("[10, 20, 30]", "[20, 10, 35]") + body)["measurements"]
    assert m["floating"] == ["c"]


def test_floating_absent_when_everything_is_held():
    m = run(
        '# --- expect ---\nEXPECT = {"bodies": 2, "bbox_mm": [20, 10, 10]}\n# --- end expect ---\n'
        + TOUCHING_PAIR_BODY
    )["measurements"]
    assert "floating" not in m
