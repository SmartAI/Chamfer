import sys, pathlib, pytest
sys.path.insert(0, str(pathlib.Path(__file__).parent.parent / "packages/client/public/py"))
import harness

BOX = """
from build123d import *
result = Box(10, 20, 30)
"""

def test_export_step_returns_step_bytes():
    data = harness.export_model(BOX, "step")
    assert isinstance(data, bytes)
    assert data.startswith(b"ISO-10303-21")

def test_export_stl_returns_nonempty_bytes():
    data = harness.export_model(BOX, "stl")
    assert isinstance(data, bytes)
    assert len(data) > 0

def test_export_3mf_returns_zip_container():
    data = harness.export_model(BOX, "3mf")
    assert isinstance(data, bytes)
    assert data.startswith(b"PK")

def test_export_py_round_trips_source():
    data = harness.export_model(BOX, "py")
    assert data == BOX.encode("utf-8")

def test_unknown_format_raises_runtime_error():
    with pytest.raises(RuntimeError, match="format"):
        harness.export_model(BOX, "obj")

def test_export_propagates_script_errors():
    with pytest.raises(RuntimeError, match="result"):
        harness.export_model("x = 1", "step")
