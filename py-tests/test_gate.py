import json
import pathlib
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).parent.parent / "packages/client/public/py"))
import harness

BOX_BODY = """
from build123d import *
result = Box(10, 20, 30)
"""

def with_expect(expect_lines: str, body: str = BOX_BODY) -> str:
    return f"# --- expect ---\nEXPECT = {expect_lines}\n# --- end expect ---\n{body}"


FULL_EXPECT = """{
    "bodies": 1,
    "bbox_mm": [30, 10, 20],
    "bbox_tol": 0.25,
    "volume_mm3": [5900, 6100],
}"""


# ---------- parse_expect ----------

def test_parse_full_block():
    out = harness.parse_expect(with_expect(FULL_EXPECT))
    assert out == {
        "bodies": 1,
        "bbox_mm": [30.0, 10.0, 20.0],
        "bbox_tol": 0.25,
        "volume_mm3": [5900.0, 6100.0],
    }

def test_parse_minimal_block_applies_defaults():
    out = harness.parse_expect(with_expect('{"bodies": 2, "bbox_mm": [1, 2, 3]}'))
    assert out["bbox_tol"] == 0.5
    assert out["volume_mm3"] is None

def test_missing_block_raises():
    with pytest.raises(ValueError, match="expect block"):
        harness.parse_expect(BOX_BODY)

def test_block_without_expect_assignment_raises():
    src = "# --- expect ---\nx = 1\n# --- end expect ---\n" + BOX_BODY
    with pytest.raises(ValueError, match="EXPECT"):
        harness.parse_expect(src)

def test_expect_not_a_dict_raises():
    with pytest.raises(ValueError, match="dict"):
        harness.parse_expect(with_expect("[1, 2]"))

def test_non_literal_expect_raises():
    with pytest.raises(ValueError):
        harness.parse_expect(with_expect('{"bodies": some_variable, "bbox_mm": [1,2,3]}'))

def test_unknown_key_raises():
    with pytest.raises(ValueError, match="holes"):
        harness.parse_expect(with_expect('{"bodies": 1, "bbox_mm": [1,2,3], "holes": 4}'))

@pytest.mark.parametrize("bodies", ['"1"', "True", "0", "-2", "1.5"])
def test_invalid_bodies_raises(bodies):
    with pytest.raises(ValueError, match="bodies"):
        harness.parse_expect(with_expect(f'{{"bodies": {bodies}, "bbox_mm": [1,2,3]}}'))

@pytest.mark.parametrize("bbox", ["[1, 2]", "[1, 2, 3, 4]", '["a", 2, 3]', "[0, 2, 3]", "5"])
def test_invalid_bbox_raises(bbox):
    with pytest.raises(ValueError, match="bbox_mm"):
        harness.parse_expect(with_expect(f'{{"bodies": 1, "bbox_mm": {bbox}}}'))

@pytest.mark.parametrize("tol", ["0", "-1", '"x"'])
def test_invalid_tol_raises(tol):
    with pytest.raises(ValueError, match="bbox_tol"):
        harness.parse_expect(with_expect(f'{{"bodies": 1, "bbox_mm": [1,2,3], "bbox_tol": {tol}}}'))

@pytest.mark.parametrize("vol", ["[1]", "[2, 1]", '"big"', "[1, 2, 3]"])
def test_invalid_volume_raises(vol):
    with pytest.raises(ValueError, match="volume_mm3"):
        harness.parse_expect(with_expect(f'{{"bodies": 1, "bbox_mm": [1,2,3], "volume_mm3": {vol}}}'))

def test_required_keys_enforced():
    with pytest.raises(ValueError, match="bbox_mm"):
        harness.parse_expect(with_expect('{"bodies": 1}'))
    with pytest.raises(ValueError, match="bodies"):
        harness.parse_expect(with_expect('{"bbox_mm": [1,2,3]}'))


# ---------- gate evaluation through run_script ----------

def gate_of(source: str) -> dict:
    return harness.run_script(source)["gate"]

def check_names(gate: dict, passed: bool) -> set:
    return {c["name"] for c in gate["checks"] if c["passed"] is passed}

def test_gate_passes_for_matching_expectations():
    gate = gate_of(with_expect(FULL_EXPECT))
    assert gate["status"] == "passed"
    assert all(c["passed"] for c in gate["checks"])
    assert {"valid", "nondegenerate", "bodies", "bbox", "volume"} <= {c["name"] for c in gate["checks"]}

def test_bbox_comparison_is_order_insensitive():
    gate = gate_of(with_expect('{"bodies": 1, "bbox_mm": [20, 30, 10]}'))
    assert gate["status"] == "passed"

def test_bbox_out_of_tolerance_fails():
    gate = gate_of(with_expect('{"bodies": 1, "bbox_mm": [30, 10, 21]}'))
    assert gate["status"] == "failed"
    assert "bbox" in check_names(gate, False)
    detail = next(c["detail"] for c in gate["checks"] if c["name"] == "bbox")
    assert "21" in detail  # diagnostic names the offending expectation

def test_bbox_within_custom_tolerance_passes():
    gate = gate_of(with_expect('{"bodies": 1, "bbox_mm": [30, 10, 21], "bbox_tol": 1.5}'))
    assert gate["status"] == "passed"

def test_bodies_mismatch_fails():
    compound = """
from build123d import *
result = Compound(children=[Box(5, 5, 5), Pos(20, 0, 0) * Box(5, 5, 5)])
"""
    gate = gate_of(with_expect('{"bodies": 1, "bbox_mm": [25, 5, 5]}', compound))
    assert gate["status"] == "failed"
    assert "bodies" in check_names(gate, False)

def test_bodies_count_matches_compound():
    compound = """
from build123d import *
result = Compound(children=[Box(5, 5, 5), Pos(20, 0, 0) * Box(5, 5, 5)])
"""
    gate = gate_of(with_expect('{"bodies": 2, "bbox_mm": [25, 5, 5]}', compound))
    assert gate["status"] == "passed"

def test_volume_out_of_range_fails():
    gate = gate_of(with_expect('{"bodies": 1, "bbox_mm": [30, 10, 20], "volume_mm3": [1, 2]}'))
    assert gate["status"] == "failed"
    assert "volume" in check_names(gate, False)

def test_missing_block_is_gate_failure_with_alwayson_checks():
    gate = gate_of(BOX_BODY)
    assert gate["status"] == "failed"
    assert "expect_block" in check_names(gate, False)
    # Always-on checks still run and pass for a healthy box.
    assert {"valid", "nondegenerate"} <= check_names(gate, True)

def test_gate_evaluator_crash_fails_open(monkeypatch):
    def boom(source, shape, frozen_check_set=None):
        raise RuntimeError("synthetic gate bug")
    monkeypatch.setattr(harness, "_run_gate_checks", boom)
    out = harness.run_script(with_expect(FULL_EXPECT))
    assert out["gate"]["status"] == "error"
    assert "synthetic gate bug" in out["gate"]["checks"][0]["detail"]
    # The run itself is unharmed.
    assert out["measurements"]["volumeMm3"] == pytest.approx(6000, rel=1e-6)

def test_run_output_is_json_serializable_with_gate():
    out = harness.run_script(with_expect(FULL_EXPECT))
    json.dumps(out)

def test_existing_output_keys_unchanged_without_block():
    out = harness.run_script(BOX_BODY)
    assert {"stdout", "measurements", "positions", "indices", "gate", "notices"} == set(out)
