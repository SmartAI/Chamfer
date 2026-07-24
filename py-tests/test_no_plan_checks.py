import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent.parent / "packages/client/public/py"))
import harness


EXPECT_BOX = '# --- expect ---\nEXPECT = {"bodies": 1, "bbox_mm": [10, 20, 30]}\n# --- end expect ---\n'

BOX_BODY = """
from build123d import *
result = Box(10, 20, 30)
"""


def with_checks(checks: str) -> str:
    return (
        EXPECT_BOX
        + f"# --- checks ---\nCHECKS = {checks}\n# --- end checks ---\n"
        + BOX_BODY
    )


def graded_checks(result: dict) -> list[dict]:
    return [check for check in result["gate"]["checks"] if check["name"].startswith("check:")]


def test_no_plan_failing_inline_check_fails_gate_and_names_check():
    result = harness.run_script(
        with_checks('[{"kind": "hole_through", "diameter": 4, "count": 1}]')
    )

    assert result["gate"]["status"] == "failed"
    check = graded_checks(result)[0]
    assert check["name"] == "check:hole_through[0]"
    assert check["passed"] is False
    assert "expected 1" in check["detail"]


def test_no_plan_passing_inline_check_is_graded():
    result = harness.run_script(with_checks('[{"kind": "count_faces", "count": 6}]'))

    assert result["gate"]["status"] == "passed"
    assert graded_checks(result) == [
        {
            "name": "check:count_faces[0]",
            "passed": True,
            "detail": "count_faces on result: expected 6, found 6",
        }
    ]
    assert result["notices"] == [
        "Graded CAD-code CHECKS declaration; no loop-owned frozen checks were supplied."
    ]


def test_frozen_checks_remain_authoritative_over_inline_checks():
    source = with_checks('[{"kind": "count_faces", "count": 999}]')
    frozen_check_set = {
        "contractId": "contract-1",
        "revision": 1,
        "checks": [
            {
                "id": "face-count",
                "componentId": "part",
                "kind": "count_faces",
                "criterion": {"kind": "count_faces", "count": 6},
            }
        ],
    }

    result = harness.run_script(source, frozen_check_set)

    assert result["gate"]["status"] == "passed"
    assert graded_checks(result) == [
        {
            "name": "check:count_faces[0]",
            "passed": True,
            "detail": "count_faces on result: expected 6, found 6",
            "checkId": "part/face-count",
        }
    ]
    assert result["notices"] == [
        "Ignored CAD-code CHECKS declaration; the verify gate used loop-owned frozen checks "
        "from proof contract contract-1 revision 1."
    ]
