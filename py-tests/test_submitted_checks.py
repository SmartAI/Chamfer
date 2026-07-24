import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent.parent / "packages/client/public/py"))
import harness


def test_submitted_checks_are_auditable_but_do_not_replace_frozen_gate_checks():
    source = """
from build123d import *
# --- expect ---
EXPECT = {"bodies": 1, "bbox_mm": [10, 10, 10]}
# --- end expect ---
# --- checks ---
CHECKS = [{"kind": "volume", "range_mm3": [900, 1100], "target": "diagnostic"}]
# --- end checks ---
# --- component ---
COMPONENT = "diagnostic"
# --- end component ---
diagnostic = Box(10, 10, 10)
diagnostic.label = "diagnostic"
result = diagnostic
"""
    frozen = {
        "contractId": "contract-1",
        "revision": 1,
        "checks": [
            {
                "id": "envelope",
                "componentId": "diagnostic",
                "kind": "bbox",
                "criterion": {"kind": "bbox", "size_mm": [10, 10, 10], "target": "diagnostic"},
            },
            {
                "id": "volume",
                "componentId": "diagnostic",
                "kind": "volume",
                "criterion": {"kind": "volume", "range_mm3": [900, 1100], "target": "diagnostic"},
            },
        ],
    }

    result = harness.run_script(source, frozen)

    assert [check["id"] for check in result["measurements"]["checks"]] == ["envelope", "volume"]
    assert result["measurements"]["submittedChecks"] == [
        {"kind": "volume", "range_mm3": [900, 1100], "target": "diagnostic"}
    ]
    assert result["gate"]["status"] == "passed"
