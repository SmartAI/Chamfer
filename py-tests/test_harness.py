import sys, pathlib, pytest
sys.path.insert(0, str(pathlib.Path(__file__).parent.parent / "packages/client/public/py"))
import harness

BOX = """
from build123d import *
result = Box(10, 20, 30)
"""

def test_run_script_measures_a_box():
    out = harness.run_script(BOX)
    assert out["measurements"]["bboxMm"] == pytest.approx([10, 20, 30], abs=1e-6)
    assert out["measurements"]["volumeMm3"] == pytest.approx(6000, rel=1e-6)
    assert len(out["positions"]) % 3 == 0 and len(out["positions"]) > 0
    assert len(out["indices"]) % 3 == 0 and max(out["indices"]) < len(out["positions"]) // 3

def test_missing_result_is_an_error():
    with pytest.raises(RuntimeError, match="result"):
        harness.run_script("x = 1")

def test_traceback_propagates():
    with pytest.raises(Exception, match="division by zero"):
        harness.run_script("from build123d import *\nresult = Box(1,1,1)\n1/0")

def test_non_shape_result_is_a_runtime_error():
    with pytest.raises(RuntimeError, match="solid 3D shape"):
        harness.run_script("result = 42")

def test_stdout_captured():
    out = harness.run_script(BOX + "\nprint('hello from script')")
    assert "hello from script" in out["stdout"]
