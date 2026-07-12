"""Executes every Python snippet bundled with the agent skills against real build123d.

The agent-facing skill bodies (packages/client/src/agent/skills/*/SKILL.md) inline
or reference these exact files, so this suite is what keeps every code example the
model reads honest. A snippet must execute cleanly and leave a valid build123d
shape in a top-level `result` variable.
"""

import pathlib

import build123d as b3d
import pytest


SKILLS_DIR = (
    pathlib.Path(__file__).parent.parent
    / "packages" / "client" / "src" / "agent" / "skills"
)
SNIPPETS = sorted(SKILLS_DIR.glob("*/snippets/*.py"))


def test_skill_snippets_exist():
    assert SNIPPETS, f"no skill snippets found under {SKILLS_DIR}"


@pytest.mark.parametrize(
    "snippet", SNIPPETS, ids=[f"{p.parent.parent.name}/{p.name}" for p in SNIPPETS]
)
def test_snippet_executes_and_yields_valid_geometry(snippet):
    namespace = {}
    exec(compile(snippet.read_text(), str(snippet), "exec"), namespace)

    result = namespace.get("result")
    assert result is not None, f"{snippet.name} must assign a top-level `result`"
    assert isinstance(result, b3d.Shape)
    assert result.is_valid
    assert result.volume > 0


def _run(name: str) -> dict:
    path = next(p for p in SNIPPETS if p.name == name)
    namespace = {}
    exec(compile(path.read_text(), str(path), "exec"), namespace)
    return namespace


def test_sweep_profile_framing_snippet_builds_one_solid():
    result = _run("sweep_profile.py")["result"]
    assert len(result.solids()) == 1
    assert result.bounding_box().size.X == pytest.approx(108.096, abs=0.01)
    assert result.bounding_box().size.Z == pytest.approx(18.703, abs=0.01)


def test_loft_stack_snippet_transitions_square_to_circle():
    result = _run("loft_stack.py")["result"]
    assert len(result.solids()) == 1
    size = result.bounding_box().size
    assert size.X == pytest.approx(40.0, abs=0.01)
    assert size.Z == pytest.approx(50.0, abs=0.01)
    # The top face must be the 10 mm-radius circle, not a square corner.
    top_face = max(result.faces(), key=lambda f: f.center().Z)
    assert top_face.bounding_box().size.X == pytest.approx(20.0, abs=0.01)


def test_sweep_diagnose_probe_reports_one_solid():
    result = _run("sweep_diagnose.py")["result"]
    assert len(result.solids()) == 1
