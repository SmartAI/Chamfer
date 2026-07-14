import sys, pathlib
import pytest
sys.path.insert(0, str(pathlib.Path(__file__).parent.parent / "packages/client/public/py"))
import harness

SRC = """# --- params ---
overall_width = 80  # [40, 200] Overall width in mm
hole_diameter = 6.5  # [2, 12] Mounting hole diameter in mm
# --- end params ---
from build123d import *
result = Box(overall_width, 20, 10)
"""

def test_parse_params():
    params = harness.parse_params(SRC)
    assert params == [
        {"name": "overall_width", "value": 80, "min": 40, "max": 200, "description": "Overall width in mm"},
        {"name": "hole_diameter", "value": 6.5, "min": 2, "max": 12, "description": "Mounting hole diameter in mm"},
    ]

def test_parse_no_block():
    assert harness.parse_params("x = 1") == []

def test_set_params_rewrites_value_and_keeps_comment():
    out = harness.set_params(SRC, {"overall_width": 120})
    assert "overall_width = 120  # [40, 200] Overall width in mm" in out
    assert harness.parse_params(out)[0]["value"] == 120
    # everything outside the block is untouched
    assert out.endswith("result = Box(overall_width, 20, 10)\n")

def test_parse_params_skips_malformed_bounds_keeps_valid_siblings():
    src = """# --- params ---
w = 5  # [1.2.3, 4] bad
h = 7  # [1, 10] height
# --- end params ---
"""
    assert harness.parse_params(src) == [
        {"name": "h", "value": 7, "min": 1, "max": 10, "description": "height"},
    ]

def test_set_params_raises_keyerror_for_param_without_valid_comment():
    src = """# --- params ---
w = 5
h = 7  # [1, 10] height
# --- end params ---
"""
    with pytest.raises(KeyError):
        harness.set_params(src, {"w": 9})
    # a parse_params-visible sibling remains rewritable
    out = harness.set_params(src, {"h": 9})
    assert "h = 9  # [1, 10] height" in out

def test_set_params_roundtrip_executes():
    out = harness.set_params(SRC, {"overall_width": 120})
    m = harness.run_script(out)["measurements"]
    assert abs(m["bboxMm"][0] - 120) < 1e-6


def test_run_script_rejects_a_visible_param_that_does_not_change_geometry():
    source = """# --- params ---
width = 10  # [5, 100] Overall width in mm
# --- end params ---
from build123d import *
result = Box(10, 20, 30)
"""

    out = harness.run_script(source)

    failed = [check for check in out["gate"]["checks"] if not check["passed"]]
    assert any(
        check["name"] == "parameter_width"
        and "does not change the executed geometry" in check["detail"]
        and "Use `width`" in check["detail"]
        for check in failed
    )


def parameter_check(source, name):
    checks = harness.run_script(source)["gate"]["checks"]
    return next(check for check in checks if check["name"] == f"parameter_{name}")


def test_run_script_accepts_a_parameter_that_changes_executed_geometry():
    check = parameter_check(SRC, "overall_width")

    assert check["passed"] is True
    assert "changes the executed geometry" in check["detail"]


def test_run_script_rejects_a_param_without_an_adjustable_range():
    source = """# --- params ---
width = 10  # [10, 10] Overall width in mm
# --- end params ---
from build123d import *
result = Box(width, 20, 30)
"""

    check = parameter_check(source, "width")

    assert check["passed"] is False
    assert "valid adjustable range" in check["detail"]


def test_run_script_probes_a_one_step_integer_range():
    source = """# --- params ---
count = 1  # [1, 2] Number of adjacent boxes
# --- end params ---
from build123d import *
result = Box(count * 10, 20, 30)
"""

    check = parameter_check(source, "count")

    assert check["passed"] is True
    assert "probe value 2" in check["detail"]


def test_run_script_tries_another_probe_when_one_in_range_value_errors():
    source = """# --- params ---
width = 10  # [5, 15] Overall width in mm
# --- end params ---
from build123d import *
if width <= 8:
    raise ValueError("width is too small for this feature")
result = Box(width, 20, 30)
"""

    check = parameter_check(source, "width")

    assert check["passed"] is True
    assert "probe value 15" in check["detail"]


def test_sub_tolerance_numeric_noise_does_not_make_a_parameter_responsive():
    source = """# --- params ---
jitter = 0  # [0, 1] Numerical jitter
# --- end params ---
from build123d import *
result = Box(10 + jitter * 1e-10, 20, 30)
"""

    check = parameter_check(source, "jitter")

    assert check["passed"] is False
    assert "does not change the executed geometry" in check["detail"]
