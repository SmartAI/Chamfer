#!/usr/bin/env python3
"""Data-driven measurement oracle for the golden agent benchmark.

Usage: oracle.py <design.step> <CASE_ID> [--cases <cases.json>]

Grades an exported STEP against the case's declared checks using real
build123d/OCP geometry analysis. Checks are name-independent measurements
only: the oracle grades what the geometry IS, never what things are called.

Requires a Python environment with build123d installed (the repo's
py-tests/.venv works: `py-tests/.venv/bin/python benchmarks/oracle/oracle.py ...`).
"""
import json
import os
import sys

from build123d import import_step
from OCP.BRepAdaptor import BRepAdaptor_Surface
from OCP.GeomAbs import GeomAbs_SurfaceType

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_CASES = os.path.join(HERE, "..", "golden", "v1", "cases.json")


# --------------------------------------------------------------------------
# Geometry loading
# --------------------------------------------------------------------------
def face_info(face):
    ad = BRepAdaptor_Surface(face.wrapped)
    t = ad.GetType()
    bb = face.bounding_box()
    info = {
        "area": float(face.area),
        "bbox": [[bb.min.X, bb.min.Y, bb.min.Z], [bb.max.X, bb.max.Y, bb.max.Z]],
    }
    if t == GeomAbs_SurfaceType.GeomAbs_Cylinder:
        cyl = ad.Cylinder()
        axis = cyl.Axis().Direction()
        loc = cyl.Axis().Location()
        info.update(
            kind="cylinder",
            radius=float(cyl.Radius()),
            axis=[axis.X(), axis.Y(), axis.Z()],
            center=[loc.X(), loc.Y(), loc.Z()],
        )
    elif t == GeomAbs_SurfaceType.GeomAbs_Plane:
        pl = ad.Plane()
        n = pl.Axis().Direction()
        info.update(kind="plane", normal=[n.X(), n.Y(), n.Z()])
    elif t == GeomAbs_SurfaceType.GeomAbs_Cone:
        info.update(kind="cone")
    else:
        info.update(kind=str(t).split(".")[-1].lower())
    return info


def load(path):
    shape = import_step(path)
    solids = shape.solids()
    bb = shape.bounding_box()
    return {
        "solidCount": len(solids),
        "volumeMm3": float(sum(s.volume for s in solids)),
        "bboxMm": [bb.size.X, bb.size.Y, bb.size.Z],
        "dimsSorted": sorted([bb.size.X, bb.size.Y, bb.size.Z]),
        "xRange": [bb.min.X, bb.max.X],
        "yRange": [bb.min.Y, bb.max.Y],
        "zRange": [bb.min.Z, bb.max.Z],
        "faces": [face_info(f) for f in shape.faces()],
    }


# --------------------------------------------------------------------------
# Check engine
# --------------------------------------------------------------------------
def approx(v, target, tol):
    return abs(v - target) <= tol


def axis_matches(f, spec):
    ax = f["axis"]
    if spec == "z":
        return abs(ax[2]) >= 0.95
    if spec == "x":
        return abs(ax[0]) >= 0.95
    if spec == "y":
        return abs(ax[1]) >= 0.95
    if spec == "horizontal":
        return abs(ax[2]) <= 0.05
    return True  # "any"


def distinct_axes(faces, xy_tol=0.5):
    groups = []
    for f in faces:
        cx, cy = f["center"][0], f["center"][1]
        for g in groups:
            if abs(g[0] - cx) <= xy_tol and abs(g[1] - cy) <= xy_tol:
                break
        else:
            groups.append((cx, cy))
    return groups


def check_cyl_group(m, c):
    faces = [f for f in m["faces"] if f["kind"] == "cylinder"]
    faces = [f for f in faces if approx(f["radius"], c["radiusMm"], c.get("rtolMm", 0.1))]
    faces = [f for f in faces if axis_matches(f, c.get("axis", "any"))]
    z0, z1 = m["zRange"]
    if c.get("throughZ"):
        allow = c.get("throughAllowMm", 2)
        faces = [f for f in faces if f["bbox"][0][2] <= z0 + allow and f["bbox"][1][2] >= z1 - allow]
    if "spanMm" in c:
        lo, hi = c["spanMm"]
        faces = [f for f in faces if lo <= (f["bbox"][1][2] - f["bbox"][0][2]) <= hi]
    if "centerZFromBaseMm" in c:
        s = c["centerZFromBaseMm"]
        faces = [f for f in faces if approx(f["center"][2] - z0, s["value"], s["tolMm"])]
    cx0 = (m["xRange"][0] + m["xRange"][1]) / 2
    cy0 = (m["yRange"][0] + m["yRange"][1]) / 2
    if "nearCenterXMm" in c:
        faces = [f for f in faces if abs(f["center"][0] - cx0) <= c["nearCenterXMm"]]
    if "topEntryWithinMm" in c:
        faces = [f for f in faces if f["bbox"][1][2] >= z1 - c["topEntryWithinMm"]]
    groups = distinct_axes(faces)
    if "edgeOffsetMm" in c:
        s = c["edgeOffsetMm"]
        x0, x1 = m["xRange"]
        y0, y1 = m["yRange"]
        groups = [
            (cx, cy)
            for cx, cy in groups
            if approx(min(cx - x0, x1 - cx), s["value"], s["tolMm"])
            and approx(min(cy - y0, y1 - cy), s["value"], s["tolMm"])
        ]
    if "positionFromCenterMm" in c:
        s = c["positionFromCenterMm"]
        groups = [
            (cx, cy)
            for cx, cy in groups
            if approx(abs(cx - cx0), s["x"], s["tolMm"]) and approx(abs(cy - cy0), s["y"], s["tolMm"])
        ]
    if "count" in c:
        ok = len(groups) == c["count"]
        detail = f"matched distinct holes={len(groups)} expected {c['count']}"
    else:
        need = c.get("minFaces", 1)
        ok = len(faces) >= need
        detail = f"matched faces={len(faces)} need >= {need}"
    return ok, detail


def check_inclined_planes(m, c):
    lo, hi = c.get("nzRange", [0.2, 0.95])
    faces = [
        f
        for f in m["faces"]
        if (f["kind"] == "plane" and lo <= abs(f["normal"][2]) <= hi and f["area"] >= c.get("minAreaMm2", 0))
        or (c.get("allowCones") and f["kind"] == "cone")
    ]
    ok = len(faces) >= c["minCount"]
    return ok, f"inclined faces={len(faces)} need >= {c['minCount']}"


def run_checks(m, checks):
    out = []
    for c in checks:
        kind = c["kind"]
        if kind == "body-count":
            ok = m["solidCount"] == c["expected"]
            detail = f"solids={m['solidCount']}"
        elif kind == "dimensions":
            exp = sorted(c["expectedMm"])
            ok = all(approx(a, b, c.get("tolMm", 0.05)) for a, b in zip(m["dimsSorted"], exp))
            detail = f"dims={[round(x, 3) for x in m['bboxMm']]} expected {c['expectedMm']}"
        elif kind == "volume-band":
            ok = c["minMm3"] <= m["volumeMm3"] <= c["maxMm3"]
            detail = f"volume={round(m['volumeMm3'])} band [{c['minMm3']},{c['maxMm3']}]"
        elif kind == "cyl-group":
            ok, detail = check_cyl_group(m, c)
        elif kind == "inclined-planes":
            ok, detail = check_inclined_planes(m, c)
        else:
            ok, detail = False, f"unknown check kind {kind}"
        out.append({"id": c.get("id", kind), "kind": kind, "status": "passed" if ok else "failed", "detail": detail})
    return out


def main():
    step_path, case_id = sys.argv[1], sys.argv[2]
    cases_path = DEFAULT_CASES
    if "--cases" in sys.argv:
        cases_path = sys.argv[sys.argv.index("--cases") + 1]
    cases = json.load(open(cases_path))["cases"]
    case = next((c for c in cases if c["id"] == case_id), None)
    if case is None:
        raise SystemExit(f"case {case_id} not found in {cases_path}")
    m = load(step_path)
    checks = run_checks(m, case["checks"])
    passed = sum(1 for c in checks if c["status"] == "passed")
    slim = dict(m)
    slim["faces"] = [f for f in m["faces"] if f["kind"] == "cylinder"]
    print(json.dumps({"case": case_id, "passed": passed, "total": len(checks), "checks": checks, "measurements": slim}, indent=1))


if __name__ == "__main__":
    main()
