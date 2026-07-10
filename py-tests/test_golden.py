"""Golden-output regression net for the harness.

Asserts that run_script and parse_params produce byte-stable output for a set
of representative scripts. Any intentional output change must regenerate the
snapshot (py-tests/golden/generate.py) in the same commit that justifies it.
"""
import json
import pathlib
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).parent.parent / "packages/client/public/py"))
import harness

GOLDEN_DIR = pathlib.Path(__file__).parent / "golden"
GOLDEN = json.loads((GOLDEN_DIR / "golden.json").read_text())


def _assert_measurements(actual: dict, expected: dict) -> None:
    assert actual["bboxMm"] == pytest.approx(expected["bboxMm"], rel=1e-6, abs=1e-9)
    assert actual["volumeMm3"] == pytest.approx(expected["volumeMm3"], rel=1e-6)
    assert actual["areaMm2"] == pytest.approx(expected["areaMm2"], rel=1e-6)
    assert len(actual["children"]) == len(expected["children"])
    for got, want in zip(actual["children"], expected["children"]):
        assert got["label"] == want["label"]
        assert got["bboxMm"] == pytest.approx(want["bboxMm"], rel=1e-6, abs=1e-9)
        assert got["volumeMm3"] == pytest.approx(want["volumeMm3"], rel=1e-6)


@pytest.mark.parametrize("name", sorted(GOLDEN))
def test_harness_output_matches_golden(name):
    source = (GOLDEN_DIR / "scripts" / f"{name}.py").read_text()
    expected = GOLDEN[name]

    out = harness.run_script(source)
    _assert_measurements(out["measurements"], expected["measurements"])
    assert out["stdout"] == expected["stdout"]
    assert len(out["positions"]) == expected["positionCount"]
    assert len(out["indices"]) == expected["indexCount"]

    assert harness.parse_params(source) == expected["params"]
