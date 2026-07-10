"""Executes user build123d scripts; measures and tessellates the result.

Runs identically under desktop CPython (tests) and Pyodide (production).
"""
import ast
import contextlib
import io
import re
import traceback

PARAMS_START = "# --- params ---"
PARAMS_END = "# --- end params ---"

EXPECT_START = "# --- expect ---"
EXPECT_END = "# --- end expect ---"
_EXPECT_REQUIRED_KEYS = ("bodies", "bbox_mm")
_EXPECT_ALLOWED_KEYS = frozenset({"bodies", "bbox_mm", "bbox_tol", "volume_mm3"})
DEFAULT_BBOX_TOL = 0.5

# Only the trailing `# [min, max] description` comment is regex-parsed; the
# assignment structure itself comes from ast.parse (comments are invisible
# to the AST, so a regex is the only option for them).
_NUMBER_RE = r"[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?"
_PARAM_COMMENT_RE = re.compile(
    rf"#\s*\[\s*({_NUMBER_RE})\s*,\s*({_NUMBER_RE})\s*\]\s*(.*)$"
)


def _find_block(lines, start_marker, end_marker):
    """Return (start, end) 0-based line indices of the marker lines, or None."""
    start = None
    for i, line in enumerate(lines):
        stripped = line.strip()
        if start is None:
            if stripped == start_marker:
                start = i
        elif stripped == end_marker:
            return start, i
    return None


def _find_params_block(lines):
    return _find_block(lines, PARAMS_START, PARAMS_END)


def _numeric_value(node):
    """Numeric value of an AST expression node, or None if not a number."""
    if isinstance(node, ast.Constant):
        v = node.value
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            return v
        return None
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
        inner = _numeric_value(node.operand)
        if inner is None:
            return None
        return -inner if isinstance(node.op, ast.USub) else inner
    return None


def _number(text):
    """Parse a min/max bound as int when possible, float otherwise."""
    try:
        return int(text)
    except ValueError:
        return float(text)


def _block_assignments(source):
    """Yield (name, value, assign_node) for param assignments inside the block.

    A param assignment is a top-level `name = <number>` statement located
    between the params markers whose source line carries a
    `# [min, max] description` comment.
    """
    lines = source.split("\n")
    block = _find_params_block(lines)
    if block is None:
        return []
    start, end = block
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return []
    found = []
    for node in tree.body:
        line_index = node.lineno - 1  # ast linenos are 1-based
        if not (start < line_index < end):
            continue
        if not isinstance(node, ast.Assign) or len(node.targets) != 1:
            continue
        target = node.targets[0]
        if not isinstance(target, ast.Name):
            continue
        value = _numeric_value(node.value)
        if value is None:
            continue
        found.append((target.id, value, node))
    return found


def _visible_assignments(source):
    """Yield (name, value, node, min, max, description) for every assignment
    that parse_params reports.

    This is the single source of truth for which params exist: the assignment
    must live in the params block, have a single-line numeric value, and carry
    a well-formed `# [min, max] description` comment on its own line. Entries
    whose bounds cannot be converted to numbers are skipped rather than
    raising, so one malformed comment never hides its valid siblings.
    """
    lines = source.split("\n")
    for name, value, node in _block_assignments(source):
        if node.value.lineno != node.value.end_lineno:
            continue
        m = _PARAM_COMMENT_RE.search(lines[node.lineno - 1])
        if m is None:
            continue
        try:
            lo = _number(m.group(1))
            hi = _number(m.group(2))
        except ValueError:
            continue
        yield name, value, node, lo, hi, m.group(3).strip()


def parse_params(source: str) -> list[dict]:
    """Parse the params block into a list of ParamSpec dicts.

    Returns [] when there is no block or no valid assignments.
    """
    return [
        {"name": name, "value": value, "min": lo, "max": hi, "description": desc}
        for name, value, _node, lo, hi, desc in _visible_assignments(source)
    ]


def set_params(source: str, values: dict[str, float]) -> str:
    """Rewrite the numeric literals of named params inside the block.

    Splices each assignment's value span (via AST line/col offsets) so the
    trailing comment and everything else is preserved. Only the exact set of
    params that parse_params reports is rewritable; unknown or non-visible
    names raise KeyError.
    """
    assignments = {name: node for name, _value, node, *_rest in _visible_assignments(source)}
    for name in values:
        if name not in assignments:
            raise KeyError(name)
    lines = source.split("\n")
    # Splice right-to-left so earlier column offsets stay valid even if two
    # rewritten assignments ever share a line.
    splices = sorted(
        ((assignments[name].value, new_value) for name, new_value in values.items()),
        key=lambda pair: (pair[0].lineno, pair[0].col_offset),
        reverse=True,
    )
    for value_node, new_value in splices:
        if value_node.lineno != value_node.end_lineno:
            raise ValueError(f"param value for line {value_node.lineno} spans multiple lines")
        i = value_node.lineno - 1
        line = lines[i]
        lines[i] = line[: value_node.col_offset] + repr(new_value) + line[value_node.end_col_offset :]
    return "\n".join(lines)


def _is_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def parse_expect(source: str) -> dict:
    """Parse and validate the expect block into a normalized dict.

    Raises ValueError with a user-facing message on a missing block, missing
    EXPECT assignment, non-literal value, or any invalid field. Returns
    {"bodies", "bbox_mm", "bbox_tol", "volume_mm3"} with defaults applied
    (bbox_tol=DEFAULT_BBOX_TOL, volume_mm3=None).
    """
    lines = source.split("\n")
    block = _find_block(lines, EXPECT_START, EXPECT_END)
    if block is None:
        raise ValueError(
            f"Script has no expect block ({EXPECT_START} / {EXPECT_END})."
        )
    start, end = block
    try:
        tree = ast.parse(source)
    except SyntaxError as e:
        raise ValueError(f"expect block: script does not parse: {e}")
    node = next(
        (
            n
            for n in tree.body
            if start < n.lineno - 1 < end
            and isinstance(n, ast.Assign)
            and len(n.targets) == 1
            and isinstance(n.targets[0], ast.Name)
            and n.targets[0].id == "EXPECT"
        ),
        None,
    )
    if node is None:
        raise ValueError("expect block must contain a single `EXPECT = {...}` assignment.")
    try:
        raw = ast.literal_eval(node.value)
    except ValueError:
        raise ValueError("EXPECT must be a literal dict (numbers, lists, strings only).")
    if not isinstance(raw, dict):
        raise ValueError("EXPECT must be a dict.")
    unknown = set(raw) - _EXPECT_ALLOWED_KEYS
    if unknown:
        raise ValueError(f"EXPECT has unknown keys: {sorted(unknown)}")
    for key in _EXPECT_REQUIRED_KEYS:
        if key not in raw:
            raise ValueError(f"EXPECT is missing required key: {key}")

    bodies = raw["bodies"]
    if not isinstance(bodies, int) or isinstance(bodies, bool) or bodies < 1:
        raise ValueError("EXPECT bodies must be an integer >= 1.")

    bbox = raw["bbox_mm"]
    if (
        not isinstance(bbox, (list, tuple))
        or len(bbox) != 3
        or not all(_is_number(v) and v > 0 for v in bbox)
    ):
        raise ValueError("EXPECT bbox_mm must be three positive numbers.")

    tol = raw.get("bbox_tol", DEFAULT_BBOX_TOL)
    if not _is_number(tol) or tol <= 0:
        raise ValueError("EXPECT bbox_tol must be a positive number.")

    volume = raw.get("volume_mm3")
    if volume is not None:
        if (
            not isinstance(volume, (list, tuple))
            or len(volume) != 2
            or not all(_is_number(v) for v in volume)
            or volume[0] > volume[1]
        ):
            raise ValueError("EXPECT volume_mm3 must be [min, max] with min <= max.")
        volume = [float(volume[0]), float(volume[1])]

    return {
        "bodies": bodies,
        "bbox_mm": [float(v) for v in bbox],
        "bbox_tol": float(tol),
        "volume_mm3": volume,
    }


def _gate_check(name, passed, detail):
    return {"name": name, "passed": bool(passed), "detail": detail}


def _run_gate_checks(source, shape):
    """All gate checks for one run: always-on validity plus the expect block."""
    volume = float(shape.volume)
    checks = [
        _gate_check("valid", shape.is_valid, "B-rep validity (is_valid)"),
        _gate_check("nondegenerate", volume > 0, f"total volume {volume:.6g} mm^3 must be > 0"),
    ]
    try:
        expect = parse_expect(source)
    except ValueError as e:
        checks.append(_gate_check("expect_block", False, str(e)))
        return checks
    checks.append(_gate_check("expect_block", True, "expect block parsed"))

    found_bodies = len(shape.solids())
    checks.append(
        _gate_check(
            "bodies",
            found_bodies == expect["bodies"],
            f"bodies: expected {expect['bodies']}, found {found_bodies}",
        )
    )

    bb = shape.bounding_box()
    measured = sorted([bb.size.X, bb.size.Y, bb.size.Z])
    wanted = sorted(expect["bbox_mm"])
    tol = expect["bbox_tol"]
    bbox_ok = all(abs(m - w) <= tol for m, w in zip(measured, wanted))
    checks.append(
        _gate_check(
            "bbox",
            bbox_ok,
            f"bbox_mm (sorted): expected {wanted} ±{tol}, measured "
            f"{[round(v, 3) for v in measured]}",
        )
    )

    if expect["volume_mm3"] is not None:
        lo, hi = expect["volume_mm3"]
        checks.append(
            _gate_check(
                "volume",
                lo <= volume <= hi,
                f"volume_mm3: expected [{lo:.6g}, {hi:.6g}], measured {volume:.6g}",
            )
        )
    return checks


def evaluate_gate(source: str, shape) -> dict:
    """Deterministic verify gate over the produced shape.

    Fail-open: any internal error becomes status "error" instead of breaking
    the run, so a gate bug can never prevent model building or export.
    """
    try:
        checks = _run_gate_checks(source, shape)
    except Exception as e:
        return {
            "status": "error",
            "checks": [_gate_check("gate", False, f"gate evaluator failed: {e!r}")],
        }
    status = "passed" if all(c["passed"] for c in checks) else "failed"
    return {"status": status, "checks": checks}


def _to_shape(result):
    part = getattr(result, "part", None)  # BuildPart and friends
    if part is not None:
        return part
    return result


def _measure_one(shape):
    bb = shape.bounding_box()
    return {
        "bboxMm": [bb.size.X, bb.size.Y, bb.size.Z],
        "volumeMm3": float(shape.volume),
    }


def _measure(shape):
    m = _measure_one(shape)
    m["areaMm2"] = float(shape.area)
    children = []
    for i, child in enumerate(getattr(shape, "children", []) or []):
        c = _measure_one(child)
        c["label"] = getattr(child, "label", "") or f"child_{i}"
        children.append(c)
    m["children"] = children
    return m


def _execute(source: str):
    """Run the script and return (result, stdout text).

    Shared by run_script and export_model so both enforce the same result
    conventions: tracebacks surface as RuntimeError, and the script must
    assign a top-level `result`.
    """
    ns = {}
    stdout = io.StringIO()
    try:
        with contextlib.redirect_stdout(stdout):
            exec(compile(source, "model.py", "exec"), ns)
    except Exception:
        raise RuntimeError(traceback.format_exc(limit=8))
    result = ns.get("result")
    if result is None:
        raise RuntimeError(
            "Script must assign the finished geometry to a top-level `result` variable."
        )
    return result, stdout.getvalue()


def run_script(source: str) -> dict:
    result, stdout_text = _execute(source)
    try:
        shape = _to_shape(result)
        vertices, triangles = shape.tessellate(tolerance=0.1)
        positions = [c for v in vertices for c in (v.X, v.Y, v.Z)]
        indices = [i for tri in triangles for i in tri]
        return {
            "stdout": stdout_text,
            "measurements": _measure(shape),
            "positions": positions,
            "indices": indices,
            "gate": evaluate_gate(source, shape),
        }
    except Exception:
        raise RuntimeError(
            "`result` must be a solid 3D shape (a build123d Part/Solid/Compound); "
            f"got {type(result).__name__!r}.\n" + traceback.format_exc(limit=8)
        )


def export_model(source: str, fmt: str) -> bytes:
    """Run the script and serialize its `result` in the requested format.

    Formats: "step" (ISO 10303 via export_step), "stl" and "3mf" (via
    Mesher), "py" (the source itself, UTF-8). Anything else raises
    RuntimeError. Files go through tempfile, which works both on desktop
    CPython and Pyodide's in-memory filesystem.
    """
    if fmt == "py":
        return source.encode("utf-8")
    if fmt not in ("step", "stl", "3mf"):
        raise RuntimeError(f"Unknown export format: {fmt!r}")
    result, _ = _execute(source)
    shape = _to_shape(result)
    import os
    import tempfile

    # Imported lazily, matching how the rest of this module avoids a
    # build123d import at module load time.
    from build123d import Mesher, export_step

    with tempfile.TemporaryDirectory() as tmp_dir:
        path = os.path.join(tmp_dir, f"model.{fmt}")
        try:
            if fmt == "step":
                export_step(shape, path)
            else:
                mesher = Mesher()
                mesher.add_shape(shape)
                mesher.write(path)
        except Exception:
            raise RuntimeError(traceback.format_exc(limit=8))
        with open(path, "rb") as f:
            return f.read()
