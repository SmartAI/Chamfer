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
    "hole_through": ({"diameter", "count"}, {"tol"}),
    "hole_blind": ({"diameter", "count"}, {"tol"}),
    "clearance": ({"a", "b", "min_mm"}, set()),
    "bbox": ({"size_mm"}, {"target", "tol"}),
    "volume": ({"range_mm3"}, {"target"}),
    "count_faces": ({"count"}, {"target"}),
    "count_edges": ({"count"}, {"target"}),
    "symmetric": ({"plane"}, {"tol_pct"}),
}
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
    if kind in ("hole_through", "hole_blind"):
        d = raw["diameter"]
        if not _is_number(d) or d <= 0:
            raise _check_error(index, "diameter must be a positive number.")
        tol = raw.get("tol", DEFAULT_CHECK_TOL)
        if not _is_number(tol) or tol <= 0:
            raise _check_error(index, "tol must be a positive number.")
        spec.update(
            diameter=float(d), tol=float(tol),
            count=_validate_count(index, raw["count"], allow_range=False),
        )
    elif kind == "clearance":
        for key in ("a", "b"):
            if not isinstance(raw[key], str) or not raw[key]:
                raise _check_error(index, f"{key} must be a non-empty child label string.")
        gap = raw["min_mm"]
        if not _is_number(gap) or gap < 0:
            raise _check_error(index, "min_mm must be a number >= 0.")
        spec.update(a=raw["a"], b=raw["b"], min_mm=float(gap))
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
        spec.update(plane=plane, tol_pct=float(tol_pct))
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
    node = next(
        (
            n
            for n in tree.body
            if start < n.lineno - 1 < end
            and isinstance(n, ast.Assign)
            and len(n.targets) == 1
            and isinstance(n.targets[0], ast.Name)
            and n.targets[0].id == "CHECKS"
        ),
        None,
    )
    if node is None:
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
    """The shape a check applies to: the whole result, or one child by label.

    Returns (shape, error_detail); exactly one is None.
    """
    if target is None:
        return shape, None
    labeled = _children_with_labels(shape)
    for label, child in labeled:
        if label == target:
            return child, None
    labels = [label for label, _ in labeled]
    return None, f"no child labeled {target!r}; available labels: {labels}"


def _eval_hole_check(spec, holes):
    wanted_kind = "through" if spec["kind"] == "hole_through" else "blind"
    d, tol = spec["diameter"], spec["tol"]
    matching = [h for h in holes if abs(h["diameterMm"] - d) <= tol]
    found = sum(1 for h in matching if h["kind"] == wanted_kind)
    others = {
        kind: sum(1 for h in matching if h["kind"] == kind)
        for kind in ("through", "blind", "internal")
        if kind != wanted_kind
    }
    other_text = ", ".join(f"{n} {kind}" for kind, n in others.items() if n)
    detail = (
        f"{wanted_kind} holes d={d:g}±{tol:g} mm: expected {spec['count']}, found {found}"
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
    return distance >= spec["min_mm"], (
        f"clearance {spec['a']}/{spec['b']}: measured {distance:.6g} mm, "
        f"required >= {spec['min_mm']:g} mm"
    )


def _count_matches(count, found):
    if isinstance(count, list):
        return count[0] <= found <= count[1], f"[{count[0]}, {count[1]}]"
    return found == count, str(count)


def _eval_check(spec, shape, holes):
    """(passed, detail) for one normalized check spec. May raise; the caller
    converts exceptions into a failed check."""
    kind = spec["kind"]
    if kind in ("hole_through", "hole_blind"):
        return _eval_hole_check(spec, holes())
    if kind == "clearance":
        return _eval_clearance_check(spec, shape)

    if kind == "symmetric":
        from build123d import Plane

        plane = getattr(Plane, spec["plane"])
        # Cutting a multi-child Compound against its mirror hands OCC several
        # exactly-coincident tools at once; its same-domain detection handles
        # that unreliably and children can come back uncut, reporting >100%
        # "asymmetric" volume on symmetric assemblies. Fuse to a single body
        # first so the mirror-difference is one well-posed boolean.
        solids = shape.solids()
        body = solids[0].fuse(*solids[1:]) if solids else shape
        mirrored = body.mirror(plane)
        volume = float(body.volume)
        # Mirroring is an isometry, so both difference directions enclose the
        # same volume; measuring one avoids double-counting (and keeps the
        # reported ratio within 0-100%).
        asymmetry = float((body - mirrored).volume)
        ratio_pct = 100 * asymmetry / volume if volume > 0 else float("inf")
        return ratio_pct <= spec["tol_pct"], (
            f"symmetry about {spec['plane']}: asymmetric volume {ratio_pct:.3g}% "
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
            m["clearances"] = _clearance_matrix(labeled)
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
