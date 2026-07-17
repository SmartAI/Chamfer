import pathlib
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).parent.parent / "packages/client/public/py"))
import harness


def run(body: str, component: str = "plate") -> dict:
    return harness.run_script(
        "\n".join([
            "from build123d import *",
            "# --- expect ---",
            'EXPECT = {"bodies": 1, "bbox_mm": [30, 20, 4], "bbox_tol": 1}',
            "# --- end expect ---",
            "# --- component ---",
            f'COMPONENT = "{component}"',
            "# --- end component ---",
            body,
        ])
    )


def integrity_check(result: dict) -> dict:
    return next(check for check in result["gate"]["checks"] if check["name"] == "single_component_integrity")


def test_named_single_valid_solid_is_conforming():
    result = run('result = Box(30, 20, 4)\nresult.label = "plate"')

    assert result["measurements"]["integrity"] == {
        "status": "conforming",
        "componentId": "plate",
        "resultLabel": "plate",
        "solidCount": 1,
        "valid": True,
        "issues": [],
    }
    assert integrity_check(result)["passed"] is True
    assert result["gate"]["status"] == "passed"


def test_detached_but_renderable_feature_is_nonconforming_even_when_expected():
    result = harness.run_script(
        "\n".join([
            "from build123d import *",
            "# --- expect ---",
            'EXPECT = {"bodies": 2, "bbox_mm": [30, 20, 4], "volume_mm3": [2040, 2440]}',
            "# --- end expect ---",
            "# --- component ---",
            'COMPONENT = "plate"',
            "# --- end component ---",
            "main = Pos(0, 0, -0.3) * Box(30, 20, 3.4)",
            "feature = Pos(0, 0, 1.75) * Box(8, 8, 0.5)",
            "result = Compound(children=[main, feature])",
            'result.label = "plate"',
        ])
    )

    integrity = result["measurements"]["integrity"]
    assert integrity["status"] == "nonconforming"
    assert integrity["solidCount"] == 2
    assert integrity["componentId"] == "plate"
    assert integrity["issues"] == [{
        "code": "disconnected-solid",
        "detail": 'Component "plate" has disconnected geometry: expected exactly 1 connected solid, found 2.',
    }]
    assert integrity_check(result)["passed"] is False
    assert "disconnected geometry" in integrity_check(result)["detail"]
    assert result["gate"]["status"] == "failed"
    assert len(result["positions"]) > 0
    assert len(result["indices"]) > 0


def test_tessellatable_invalid_topology_is_returned_as_a_nonconforming_result():
    result = run(
        "\n".join([
            "closed = Box(30, 20, 4)",
            "open_shell = Shell(closed.faces()[:-1])",
            "result = Solid(open_shell)",
            'result.label = "plate"',
        ])
    )

    integrity = result["measurements"]["integrity"]
    assert integrity["status"] == "nonconforming"
    assert integrity["valid"] is False
    assert integrity["issues"] == [{
        "code": "invalid-topology",
        "detail": 'Component "plate" has invalid B-rep topology.',
    }]
    assert result["gate"]["status"] == "failed"
    assert len(result["positions"]) > 0


@pytest.mark.parametrize("result_label", ["", "housing"])
def test_component_identity_requires_the_result_label_to_match(result_label: str):
    label_line = f'result.label = "{result_label}"' if result_label else ""
    result = run(f"result = Box(30, 20, 4)\n{label_line}")

    integrity = result["measurements"]["integrity"]
    assert integrity["status"] == "nonconforming"
    assert integrity["issues"][0]["code"] == "component-identity"
    assert "plate" in integrity["issues"][0]["detail"]
    assert result["gate"]["status"] == "failed"


def test_probe_and_multi_component_runs_keep_existing_compatibility():
    probe = run("result = Box(30, 20, 4)", component="probe")
    assert "integrity" not in probe["measurements"]
    assert not any(check["name"] == "single_component_integrity" for check in probe["gate"]["checks"])

    assembly = harness.run_script(
        "\n".join([
            "from build123d import *",
            "# --- expect ---",
            'EXPECT = {"bodies": 2, "bbox_mm": [20, 10, 10]}',
            "# --- end expect ---",
            'COMPONENT = ["base", "lid"]',
            "base = Box(10, 10, 10)",
            "lid = Pos(10, 0, 0) * Box(10, 10, 10)",
            "result = Compound(children=[base, lid])",
        ])
    )
    assert "integrity" not in assembly["measurements"]
    assert assembly["gate"]["status"] == "passed"
