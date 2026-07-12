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

CHECKS_START = "# --- checks ---"
CHECKS_END = "# --- end checks ---"
MAX_CHECKS = 32
DEFAULT_CHECK_TOL = 0.5
DEFAULT_SYMMETRY_TOL_PCT = 1.0

COMPONENT_START = "# --- component ---"
COMPONENT_END = "# --- end component ---"
# Component ids double as plan component ids and Compound child labels; "probe"
# marks a diagnostic run that never advances the plan.
_COMPONENT_ID_RE = re.compile(r"^[a-z][a-z0-9_-]{0,31}$")
PROBE_COMPONENT = "probe"

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


# ---------- agent-authored checks (test-driven CAD) ----------

# Each kind maps to {required keys, optional keys}; "kind" itself is implicit.
_CHECK_KEYS = {
    "hole_through": ({"diameter", "count"}, {"at_mm", "tol", "target"}),
    "hole_blind": ({"diameter", "count"}, {"at_mm", "tol", "target"}),
    "hole_internal": ({"diameter", "count"}, {"at_mm", "tol", "target"}),
    "clearance": ({"a", "b", "min_mm"}, {"max_mm"}),
    "bbox": ({"size_mm"}, {"target", "tol"}),
    "volume": ({"range_mm3"}, {"target"}),
    "wall_thickness": ({"range_mm"}, {"target"}),
    "count_faces": ({"count"}, {"target"}),
    "count_edges": ({"count"}, {"target"}),
    "symmetric": ({"plane"}, {"target", "tol_pct"}),
}
_HOLE_CHECK_KINDS = {"hole_through": "through", "hole_blind": "blind", "hole_internal": "internal"}
_SYMMETRY_PLANES = ("XY", "XZ", "YZ")


def _check_error(index, message):
    return ValueError(f"CHECKS[{index}]: {message}")


def _validate_count(index, value, allow_range):
    """An exact count (int >= 0) or, when allowed, an inclusive [min, max]."""
    if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
        return value
    if allow_range and isinstance(value, (list, tuple)) and len(value) == 2:
        lo, hi = value
        if (
            all(isinstance(v, int) and not isinstance(v, bool) and v >= 0 for v in (lo, hi))
            and lo <= hi
        ):
            return [lo, hi]
    expected = "an integer >= 0" + (" or [min, max]" if allow_range else "")
    raise _check_error(index, f"count must be {expected}.")


def _validate_check(index, raw):
    """Validate one CHECKS entry and return its normalized spec dict."""
    if not isinstance(raw, dict):
        raise _check_error(index, "each check must be a dict.")
    kind = raw.get("kind")
    if kind not in _CHECK_KEYS:
        raise _check_error(
            index, f"unknown kind {kind!r}; allowed: {sorted(_CHECK_KEYS)}"
        )
    required, optional = _CHECK_KEYS[kind]
    keys = set(raw) - {"kind"}
    missing = required - keys
    if missing:
        raise _check_error(index, f"{kind} is missing keys: {sorted(missing)}")
    unknown = keys - required - optional
    if unknown:
        raise _check_error(index, f"{kind} has unknown keys: {sorted(unknown)}")

    spec = {"kind": kind}
    if kind in _HOLE_CHECK_KINDS:
        d = raw["diameter"]
        if not _is_number(d) or d <= 0:
            raise _check_error(index, "diameter must be a positive number.")
        tol = raw.get("tol", DEFAULT_CHECK_TOL)
        if not _is_number(tol) or tol <= 0:
            raise _check_error(index, "tol must be a positive number.")
        spec.update(
            diameter=float(d), tol=float(tol),
            count=_validate_count(index, raw["count"], allow_range=False),
            target=_target(index, raw),
        )
        if "at_mm" in raw:
            at = raw["at_mm"]
            if (
                not isinstance(at, (list, tuple))
                or len(at) != 3
                or not all(_is_number(v) for v in at)
            ):
                raise _check_error(index, "at_mm must be three numbers.")
            spec["at_mm"] = [float(v) for v in at]
    elif kind == "clearance":
        for key in ("a", "b"):
            if not isinstance(raw[key], str) or not raw[key]:
                raise _check_error(index, f"{key} must be a non-empty child label string.")
        gap = raw["min_mm"]
        if not _is_number(gap) or gap < 0:
            raise _check_error(index, "min_mm must be a number >= 0.")
        spec.update(a=raw["a"], b=raw["b"], min_mm=float(gap))
        if "max_mm" in raw:
            max_mm = raw["max_mm"]
            if not _is_number(max_mm) or max_mm < gap:
                raise _check_error(index, "max_mm must be a number >= min_mm.")
            spec.update(max_mm=float(max_mm))
    elif kind == "bbox":
        size = raw["size_mm"]
        if (
            not isinstance(size, (list, tuple))
            or len(size) != 3
            or not all(_is_number(v) and v > 0 for v in size)
        ):
            raise _check_error(index, "size_mm must be three positive numbers.")
        tol = raw.get("tol", DEFAULT_CHECK_TOL)
        if not _is_number(tol) or tol <= 0:
            raise _check_error(index, "tol must be a positive number.")
        spec.update(size_mm=[float(v) for v in size], tol=float(tol), target=_target(index, raw))
    elif kind == "volume":
        rng = raw["range_mm3"]
        if (
            not isinstance(rng, (list, tuple))
            or len(rng) != 2
            or not all(_is_number(v) for v in rng)
            or rng[0] > rng[1]
        ):
            raise _check_error(index, "range_mm3 must be [min, max] with min <= max.")
        spec.update(range_mm3=[float(rng[0]), float(rng[1])], target=_target(index, raw))
    elif kind == "wall_thickness":
        rng = raw["range_mm"]
        if (
            not isinstance(rng, (list, tuple))
            or len(rng) != 2
            or not all(_is_number(v) and v > 0 for v in rng)
            or rng[0] > rng[1]
        ):
            raise _check_error(index, "range_mm must be [min, max] with 0 < min <= max.")
        spec.update(range_mm=[float(rng[0]), float(rng[1])], target=_target(index, raw))
    elif kind in ("count_faces", "count_edges"):
        spec.update(
            count=_validate_count(index, raw["count"], allow_range=True),
            target=_target(index, raw),
        )
    elif kind == "symmetric":
        plane = raw["plane"]
        if plane not in _SYMMETRY_PLANES:
            raise _check_error(index, f"plane must be one of {list(_SYMMETRY_PLANES)}.")
        tol_pct = raw.get("tol_pct", DEFAULT_SYMMETRY_TOL_PCT)
        if not _is_number(tol_pct) or tol_pct <= 0:
            raise _check_error(index, "tol_pct must be a positive number.")
        spec.update(plane=plane, tol_pct=float(tol_pct), target=_target(index, raw))
    return spec


def _target(index, raw):
    target = raw.get("target")
    if target is not None and (not isinstance(target, str) or not target):
        raise _check_error(index, "target must be a non-empty child label string.")
    return target


def parse_checks(source: str):
    """Parse and validate the optional checks block.

    Returns None when the script has no checks block, otherwise the list of
    normalized check specs. Raises ValueError with a user-facing message on
    any malformed block or entry.
    """
    lines = source.split("\n")
    block = _find_block(lines, CHECKS_START, CHECKS_END)
    if block is None:
        return None
    start, end = block
    try:
        tree = ast.parse(source)
    except SyntaxError as e:
        raise ValueError(f"checks block: script does not parse: {e}")
    nodes = _assignment_nodes(tree, "CHECKS")
    if len(nodes) != 1:
        raise ValueError("checks block must contain exactly one `CHECKS = [...]` assignment.")
    node = nodes[0]
    if not start < node.lineno - 1 < end:
        raise ValueError("checks block must contain a single `CHECKS = [...]` assignment.")
    try:
        raw = ast.literal_eval(node.value)
    except ValueError:
        raise ValueError("CHECKS must be a literal list (numbers, lists, strings only).")
    if not isinstance(raw, (list, tuple)):
        raise ValueError("CHECKS must be a list of check dicts.")
    if len(raw) > MAX_CHECKS:
        raise ValueError(f"CHECKS has {len(raw)} entries; at most {MAX_CHECKS} allowed.")
    return [_validate_check(i, entry) for i, entry in enumerate(raw)]


def _assignment_nodes(tree, name):
    return [
        node
        for node in tree.body
        if isinstance(node, ast.Assign)
        and len(node.targets) == 1
        and isinstance(node.targets[0], ast.Name)
        and node.targets[0].id == name
    ]


def _single_assignment(source, name, context):
    """The literal value of a unique top-level `NAME = <literal>` assignment,
    or None when the script has no such assignment."""
    try:
        tree = ast.parse(source)
    except SyntaxError as e:
        raise ValueError(f"{context}: script does not parse: {e}")
    nodes = _assignment_nodes(tree, name)
    if not nodes:
        return None
    if len(nodes) != 1:
        raise ValueError(f"{context}: {name} must have exactly one top-level assignment.")
    node = nodes[0]
    try:
        return ast.literal_eval(node.value)
    except ValueError:
        raise ValueError(f"{context}: {name} must be a literal value.")


def parse_component(source: str):
    """Parse the optional COMPONENT declaration (plan evidence link).

    Returns None when the script declares nothing, the declared string, or the
    declared list of id strings. Raises ValueError with a user-facing message
    on a malformed declaration; the gate surfaces that as a failed check.
    """
    raw = _single_assignment(source, "COMPONENT", "component declaration")
    if raw is None:
        return None
    ids = [raw] if isinstance(raw, str) else list(raw) if isinstance(raw, (list, tuple)) else None
    if not ids or not all(isinstance(i, str) for i in ids):
        raise ValueError("COMPONENT must be a non-empty string or list of strings.")
    for component_id in ids:
        if not _COMPONENT_ID_RE.match(component_id):
            raise ValueError(
                f"COMPONENT id {component_id!r} must be a lowercase slug "
                "(letters, digits, _ or -, starting with a letter)."
            )
    if PROBE_COMPONENT in ids and len(ids) > 1:
        raise ValueError('COMPONENT "probe" marks a diagnostic run and cannot be combined with component ids.')
    return raw if isinstance(raw, str) else ids


def checks_literal(source: str):
    """The raw CHECKS entries exactly as the script wrote them, or None.

    Echoed in measurements so the plan's evidence rule can compare an accepted
    plan's per-component checks against what a gate-passed run actually ran.
    Raises ValueError on an unparseable script or non-list CHECKS.
    """
    raw = _single_assignment(source, "CHECKS", "checks block")
    if raw is None:
        return None
    if not isinstance(raw, (list, tuple)):
        raise ValueError("CHECKS must be a list of check dicts.")
    return list(raw)


# ---------- geometric diagnostics ----------

_HOLE_PROBE_EPS_MM = 0.1  # how far past a hole's ends to probe for material
_FULL_CIRCLE_COVERAGE = 0.95 * 2 * 3.141592653589793
_CONTACT_TOL_MM = 1e-6
_OVERLAP_TOL_MM3 = 1e-6


def _children_with_labels(shape):
    """(label, child) pairs for a Compound's children, defaulting labels
    to child_<i> exactly like the measurements payload."""
    return [
        (getattr(child, "label", "") or f"child_{i}", child)
        for i, child in enumerate(getattr(shape, "children", []) or [])
    ]


def _topology_counts(shape):
    return {
        "faces": len(shape.faces()),
        "edges": len(shape.edges()),
        "vertices": len(shape.vertices()),
        "shells": len(shape.shells()),
    }


def _canonical_direction(direction):
    """Flip a gp_Dir so its first significant component is positive; holes
    drilled +Z and -Z share one axis identity."""
    v = (direction.X(), direction.Y(), direction.Z())
    for component in v:
        if abs(component) > 1e-9:
            return v if component > 0 else (-v[0], -v[1], -v[2])
    return v


def _point_in_any_solid(classifiers, x, y, z):
    from OCP.gp import gp_Pnt
    from OCP.TopAbs import TopAbs_IN

    point = gp_Pnt(x, y, z)
    for classifier in classifiers:
        classifier.Perform(point, 1e-7)
        if classifier.State() == TopAbs_IN:
            return True
    return False


def _hole_census(shape):
    """Detect drilled holes: concave, (near-)full cylindrical bores.

    Cylindrical faces are grouped by axis and radius, coaxial fragments are
    merged into axial intervals, and partial wraps (fillets, slot ends) are
    discarded. Each hole is probed just past both ends: material at exactly
    one end means blind, at neither end through, at both ends internal. In a
    multi-solid result the probe tests all solids, so a hole capped by a
    neighbouring body reports blind at the assembly level.
    """
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.BRepClass3d import BRepClass3d_SolidClassifier
    from OCP.GeomAbs import GeomAbs_Cylinder
    from build123d import Vector

    groups = {}
    for face in shape.faces():
        surface = BRepAdaptor_Surface(face.wrapped)
        if surface.GetType() != GeomAbs_Cylinder:
            continue
        cylinder = surface.Cylinder()
        radius = cylinder.Radius()
        axis = cylinder.Axis()
        direction = _canonical_direction(axis.Direction())
        loc = axis.Location()
        loc_v = (loc.X(), loc.Y(), loc.Z())
        along = sum(l * d for l, d in zip(loc_v, direction))
        anchor = tuple(l - along * d for l, d in zip(loc_v, direction))

        u0, u1 = surface.FirstUParameter(), surface.LastUParameter()
        v0, v1 = surface.FirstVParameter(), surface.LastVParameter()
        u_mid = (u0 + u1) / 2
        ends = []
        for v in (v0, v1):
            p = surface.Value(u_mid, v)
            ends.append(sum((c - a) * d for c, a, d in zip((p.X(), p.Y(), p.Z()), anchor, direction)))
        t0, t1 = sorted(ends)

        # Concavity: a bore's outward normal points at the axis, a boss's away.
        sample = surface.Value(u_mid, (v0 + v1) / 2)
        sample_v = Vector(sample.X(), sample.Y(), sample.Z())
        normal = face.normal_at(sample_v)
        t_sample = sum((c - a) * d for c, a, d in zip(tuple(sample_v), anchor, direction))
        on_axis = Vector(*(a + t_sample * d for a, d in zip(anchor, direction)))
        if normal.dot(on_axis - sample_v) <= 0:
            continue

        key = (
            tuple(round(d, 4) for d in direction),
            tuple(round(a, 3) for a in anchor),
            round(radius, 4),
        )
        groups.setdefault(key, {"direction": direction, "anchor": anchor, "radius": radius, "spans": []})
        groups[key]["spans"].append((t0, t1, abs(u1 - u0)))

    solids = shape.solids()
    classifiers = [BRepClass3d_SolidClassifier(s.wrapped) for s in solids]
    holes = []
    for group in groups.values():
        spans = sorted(group["spans"])
        merged = []  # [t0, t1, u_coverage] per contiguous axial interval
        for t0, t1, u_span in spans:
            if merged and t0 <= merged[-1][1] + 1e-3:
                merged[-1][1] = max(merged[-1][1], t1)
                merged[-1][2] += u_span
            else:
                merged.append([t0, t1, u_span])
        for t0, t1, coverage in merged:
            if coverage < _FULL_CIRCLE_COVERAGE:
                continue
            direction, anchor = group["direction"], group["anchor"]
            in_material = [
                _point_in_any_solid(
                    classifiers, *(a + t * d for a, d in zip(anchor, direction))
                )
                for t in (t0 - _HOLE_PROBE_EPS_MM, t1 + _HOLE_PROBE_EPS_MM)
            ]
            kind = ("internal", "blind", "through")[2 - sum(in_material)]
            center = [a + ((t0 + t1) / 2) * d for a, d in zip(anchor, direction)]
            holes.append(
                {
                    "diameterMm": 2 * group["radius"],
                    "depthMm": t1 - t0,
                    "kind": kind,
                    "axisDir": [round(d, 6) for d in direction],
                    "centerMm": [round(c, 6) for c in center],
                }
            )
    holes.sort(key=lambda h: (h["diameterMm"], h["centerMm"]))
    return holes


def _pair_clearance(a, b):
    """Clearance verdict for two shapes: interpenetrating (overlap volume),
    touching, or apart (minimum distance)."""
    from OCP.BRepExtrema import BRepExtrema_DistShapeShape

    extrema = BRepExtrema_DistShapeShape(a.wrapped, b.wrapped)
    distance = extrema.Value() if extrema.IsDone() else None
    if distance is not None and distance > _CONTACT_TOL_MM:
        return {"state": "apart", "distanceMm": distance}
    # Shape.intersect() returns a ShapeList (no volume); the & operator runs
    # the actual boolean and returns a measurable Shape.
    overlap = a & b
    volume = float(getattr(overlap, "volume", 0.0) or 0.0)
    if volume > _OVERLAP_TOL_MM3:
        return {"state": "interpenetrating", "overlapMm3": volume}
    return {"state": "touching", "distanceMm": 0.0}


def _clearance_matrix(labeled_children):
    out = []
    for i, (label_a, a) in enumerate(labeled_children):
        for label_b, b in labeled_children[i + 1 :]:
            entry = {"a": label_a, "b": label_b}
            entry.update(_pair_clearance(a, b))
            out.append(entry)
    return out


def _gate_check(name, passed, detail):
    return {"name": name, "passed": bool(passed), "detail": detail}


def _resolve_target(shape, target):
    """The shape a check applies to: the whole result, one child by label, or
    the result itself when its own label matches (so a single-component run
    with `result.label = "base"` satisfies the same targeted checks as the
    assembly's "base" child does later).

    Returns (shape, error_detail); exactly one is None.
    """
    if target is None:
        return shape, None
    if (getattr(shape, "label", "") or "") == target:
        return shape, None
    labeled = _children_with_labels(shape)
    for label, child in labeled:
        if label == target:
            return child, None
    labels = [label for label, _ in labeled]
    return None, f"no child labeled {target!r}; available labels: {labels}"


def _eval_hole_check(spec, holes, label):
    wanted_kind = _HOLE_CHECK_KINDS[spec["kind"]]
    d, tol = spec["diameter"], spec["tol"]
    matching = [h for h in holes if abs(h["diameterMm"] - d) <= tol]
    at = spec.get("at_mm")
    if at is not None:
        matching = [
            h
            for h in matching
            if sum((found - wanted) ** 2 for found, wanted in zip(h["centerMm"], at)) ** 0.5
            <= tol
        ]
    found = sum(1 for h in matching if h["kind"] == wanted_kind)
    others = {
        kind: sum(1 for h in matching if h["kind"] == kind)
        for kind in ("through", "blind", "internal")
        if kind != wanted_kind
    }
    other_text = ", ".join(f"{n} {kind}" for kind, n in others.items() if n)
    scope = f" in {label}" if label else ""
    anchor = f" at {[round(v, 6) for v in at]}" if at is not None else ""
    detail = (
        f"{wanted_kind} holes{scope}{anchor} d={d:g}±{tol:g} mm: "
        f"expected {spec['count']}, found {found}"
        + (f" (also {other_text} at this diameter)" if other_text else "")
    )
    return found == spec["count"], detail


def _eval_clearance_check(spec, shape):
    a, a_err = _resolve_target(shape, spec["a"])
    b, b_err = _resolve_target(shape, spec["b"])
    err = a_err or b_err
    if err:
        return False, f"clearance {spec['a']}/{spec['b']}: {err}"
    verdict = _pair_clearance(a, b)
    if verdict["state"] == "interpenetrating":
        return False, (
            f"clearance {spec['a']}/{spec['b']}: interpenetrating by "
            f"{verdict['overlapMm3']:.6g} mm^3 (required gap >= {spec['min_mm']:g} mm)"
        )
    distance = verdict["distanceMm"]
    max_mm = spec.get("max_mm")
    if max_mm is None:
        return distance >= spec["min_mm"], (
            f"clearance {spec['a']}/{spec['b']}: measured {distance:.6g} mm, "
            f"required >= {spec['min_mm']:g} mm"
        )
    # A bounded gap: max_mm 0 asserts contact ("touching"), a [min, max] range
    # asserts a controlled fit. Interpenetration failed above either way.
    return spec["min_mm"] <= distance <= max_mm, (
        f"clearance {spec['a']}/{spec['b']}: measured {distance:.6g} mm, "
        f"required {spec['min_mm']:g}..{max_mm:g} mm"
    )


def _count_matches(count, found):
    if isinstance(count, list):
        return count[0] <= found <= count[1], f"[{count[0]}, {count[1]}]"
    return found == count, str(count)


def _wall_thickness_samples(shape):
    """Cast one inward-normal ray per face and return first-exit distances."""
    from OCP.IntCurvesFace import IntCurvesFace_ShapeIntersector
    from OCP.gp import gp_Dir, gp_Lin, gp_Pnt

    bb = shape.bounding_box()
    ray_length = 2 * (bb.size.X ** 2 + bb.size.Y ** 2 + bb.size.Z ** 2) ** 0.5
    if ray_length <= 0:
        return []

    intersector = IntCurvesFace_ShapeIntersector()
    intersector.Load(shape.wrapped, 1e-7)
    samples = []
    for face in shape.faces():
        point = face.center()
        inward = -face.normal_at(point)
        line = gp_Lin(gp_Pnt(*point), gp_Dir(*inward))
        intersector.Perform(line, 1e-6, ray_length)
        distances = [
            intersector.WParameter(i)
            for i in range(1, intersector.NbPnt() + 1)
            if intersector.WParameter(i) > 1e-6
        ]
        if distances:
            samples.append(min(distances))
    return samples


def _eval_check(spec, shape, holes):
    """(passed, detail) for one normalized check spec. May raise; the caller
    converts exceptions into a failed check."""
    kind = spec["kind"]
    if kind in _HOLE_CHECK_KINDS:
        target_label = spec.get("target")
        if target_label is None:
            return _eval_hole_check(spec, holes(), None)
        # A targeted hole check runs the census on that child in isolation, so a
        # bore capped or occupied by a neighbouring part still classifies by the
        # component's own geometry (through), not the assembly's (blind/internal).
        target, err = _resolve_target(shape, target_label)
        if err:
            return False, f"{kind} on {target_label}: {err}"
        return _eval_hole_check(spec, _hole_census(target), target_label)
    if kind == "clearance":
        return _eval_clearance_check(spec, shape)

    if kind == "symmetric":
        from build123d import Plane

        plane = getattr(Plane, spec["plane"])
        target_label = spec.get("target")
        target, err = _resolve_target(shape, target_label)
        if err:
            return False, f"symmetric on {target_label}: {err}"
        # Cutting a multi-child Compound against its mirror hands OCC several
        # exactly-coincident tools at once; its same-domain detection handles
        # that unreliably and children can come back uncut, reporting >100%
        # "asymmetric" volume on symmetric assemblies. Fuse to a single body
        # first so the mirror-difference is one well-posed boolean.
        solids = target.solids()
        body = solids[0].fuse(*solids[1:]) if solids else target
        mirrored = body.mirror(plane)
        volume = float(body.volume)
        # Mirroring is an isometry, so both difference directions enclose the
        # same volume; measuring one avoids double-counting (and keeps the
        # reported ratio within 0-100%).
        asymmetry = float((body - mirrored).volume)
        ratio_pct = 100 * asymmetry / volume if volume > 0 else float("inf")
        subject = f"symmetry of {target_label} about" if target_label else "symmetry about"
        return ratio_pct <= spec["tol_pct"], (
            f"{subject} {spec['plane']}: asymmetric volume {ratio_pct:.3g}% "
            f"of total, allowed <= {spec['tol_pct']:g}%"
        )

    target, err = _resolve_target(shape, spec.get("target"))
    label = spec.get("target") or "result"
    if err:
        return False, f"{kind} on {label}: {err}"
    if kind == "bbox":
        bb = target.bounding_box()
        measured = sorted([bb.size.X, bb.size.Y, bb.size.Z])
        wanted = sorted(spec["size_mm"])
        tol = spec["tol"]
        ok = all(abs(m - w) <= tol for m, w in zip(measured, wanted))
        return ok, (
            f"bbox of {label} (sorted): expected {wanted} ±{tol:g}, "
            f"measured {[round(v, 3) for v in measured]}"
        )
    if kind == "volume":
        lo, hi = spec["range_mm3"]
        volume = float(target.volume)
        return lo <= volume <= hi, (
            f"volume of {label}: expected [{lo:.6g}, {hi:.6g}] mm^3, measured {volume:.6g}"
        )
    if kind == "wall_thickness":
        samples = _wall_thickness_samples(target)
        if not samples:
            return False, f"wall_thickness on {label}: no measurable face samples"
        measured_min, measured_max = min(samples), max(samples)
        lo, hi = spec["range_mm"]
        return lo <= measured_min and measured_max <= hi, (
            f"wall_thickness on {label}: expected [{lo:g}, {hi:g}] mm, measured "
            f"[{measured_min:.6g}, {measured_max:.6g}] mm from {len(samples)} faces"
        )
    if kind in ("count_faces", "count_edges"):
        found = len(target.faces() if kind == "count_faces" else target.edges())
        ok, wanted = _count_matches(spec["count"], found)
        return ok, f"{kind} on {label}: expected {wanted}, found {found}"
    raise ValueError(f"unhandled check kind {kind!r}")


def _run_agent_checks(source, shape):
    """Gate entries for the agent-authored checks block, [] when absent."""
    try:
        specs = parse_checks(source)
    except ValueError as e:
        return [_gate_check("checks_block", False, str(e))]
    if specs is None:
        return []
    out = [_gate_check("checks_block", True, f"checks block parsed ({len(specs)} checks)")]

    census = {}

    def holes():
        if "value" not in census:
            census["value"] = _hole_census(shape)
        return census["value"]

    for i, spec in enumerate(specs):
        name = f"check:{spec['kind']}[{i}]"
        try:
            passed, detail = _eval_check(spec, shape, holes)
        except Exception as e:
            passed, detail = False, f"check evaluator failed: {e!r}"
        out.append(_gate_check(name, passed, detail))
    return out


def _run_gate_checks(source, shape):
    """All gate checks for one run: always-on validity plus the expect block."""
    volume = float(shape.volume)
    checks = [
        _gate_check("valid", shape.is_valid, "B-rep validity (is_valid)"),
        _gate_check("nondegenerate", volume > 0, f"total volume {volume:.6g} mm^3 must be > 0"),
    ]
    try:
        parse_component(source)
    except ValueError as e:
        checks.append(_gate_check("component_block", False, str(e)))
    try:
        expect = parse_expect(source)
    except ValueError as e:
        checks.append(_gate_check("expect_block", False, str(e)))
        checks.extend(_run_agent_checks(source, shape))
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
    checks.extend(_run_agent_checks(source, shape))
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
    labeled = _children_with_labels(shape)
    children = []
    for label, child in labeled:
        c = _measure_one(child)
        c["label"] = label
        children.append(c)
    m["children"] = children
    # Diagnostics are fail-open like the gate: a diagnostics bug degrades the
    # feedback (field omitted) but never breaks the run.
    try:
        m["topology"] = _topology_counts(shape)
    except Exception:
        pass
    try:
        m["holes"] = _hole_census(shape)
    except Exception:
        pass
    if len(labeled) >= 2:
        try:
            matrix = _clearance_matrix(labeled)
            m["clearances"] = matrix
            # A child in contact with nothing (every pairwise state "apart") is
            # floating: unsupported, unlocated, unassemblable. Listed only when
            # non-empty so single-part and fully-connected results are unchanged.
            in_contact = set()
            for entry in matrix:
                if entry["state"] != "apart":
                    in_contact.add(entry["a"])
                    in_contact.add(entry["b"])
            floating = [label for label, _ in labeled if label not in in_contact]
            if floating:
                m["floating"] = floating
        except Exception:
            pass
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
        measurements = _measure(shape)
        # Plan evidence echo: which component(s) this run declared, and the raw
        # CHECKS entries it ran. Malformed declarations surface through the gate
        # (component_block / checks_block checks), not here.
        try:
            component = parse_component(source)
            if component is not None:
                measurements["component"] = component
        except ValueError:
            pass
        try:
            raw_checks = checks_literal(source)
            if raw_checks is not None:
                measurements["checks"] = raw_checks
        except ValueError:
            pass
        return {
            "stdout": stdout_text,
            "measurements": measurements,
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
