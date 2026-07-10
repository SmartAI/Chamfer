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
