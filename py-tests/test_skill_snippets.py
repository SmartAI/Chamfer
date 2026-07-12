import pathlib

import build123d as b3d
import pytest


SNIPPETS = pathlib.Path(__file__).parent / "skill_snippets"


def test_sweep_profile_framing_snippet_builds_one_solid():
    namespace = {}
    exec((SNIPPETS / "sweep_profile.py").read_text(), namespace)

    result = namespace["result"]
    assert isinstance(result, b3d.Part)
    assert len(result.solids()) == 1
    assert result.bounding_box().size.X == pytest.approx(108.096, abs=0.01)
    assert result.bounding_box().size.Z == pytest.approx(18.703, abs=0.01)
