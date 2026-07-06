"""Pure-stdlib STEP reader for syntactic and structural checks."""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import CheckResult


class StepParseError(ValueError):
    """Raised when a STEP file cannot be parsed."""


@dataclass(frozen=True)
class StepDoc:
    header: dict[str, str]
    products: list[str]
    colours: dict[str, tuple[float, float, float]]
    raw_entities: int


_ENTITY_RE = re.compile(
    r"#(?P<id>\d+)\s*=\s*(?P<kind>[A-Z0-9_]+)\s*\((?P<body>.*?)\)\s*;",
    re.IGNORECASE | re.DOTALL,
)
_REF_RE = re.compile(r"#(\d+)")
_STRING_RE = re.compile(r"'((?:[^']|'')*)'")

_APPEARANCE_RGB = {
    "stainless": (0.65, 0.65, 0.62),
    "matte_black": (0.01, 0.01, 0.01),
    "black": (0.0, 0.0, 0.0),
    "white": (1.0, 1.0, 1.0),
    "red": (1.0, 0.0, 0.0),
    "green": (0.0, 0.7, 0.0),
    "blue": (0.0, 0.0, 1.0),
}
_COLOUR_TOL = 0.08


def parse_step(path: str | Path) -> StepDoc:
    p = Path(path)
    try:
        text = p.read_text(encoding="utf-8", errors="replace")
    except OSError as e:
        raise StepParseError(f"cannot read STEP file {p}: {e}") from e
    if "ISO-10303-21" not in text or "END-ISO-10303-21" not in text:
        raise StepParseError("missing ISO-10303-21 header or footer")
    if "DATA;" not in text or "ENDSEC;" not in text:
        raise StepParseError("missing DATA/ENDSEC section")

    entities = _entities(text)
    if not entities:
        raise StepParseError("STEP DATA section has no entities")
    products_by_id = {
        eid: _first_string(body)
        for eid, (kind, body) in entities.items()
        if kind == "PRODUCT" and _first_string(body)
    }
    colour_by_id = {
        eid: _colour_rgb(body)
        for eid, (kind, body) in entities.items()
        if kind == "COLOUR_RGB"
    }
    colours: dict[str, tuple[float, float, float]] = {}
    for eid, (kind, body) in entities.items():
        if kind != "STYLED_ITEM":
            continue
        product_id = _first_ref_matching(body, products_by_id)
        if product_id is None:
            continue
        colour = _first_reachable_colour(eid, entities, colour_by_id)
        if colour is not None:
            colours[products_by_id[product_id]] = colour
    return StepDoc(
        header=_header(text),
        products=list(products_by_id.values()),
        colours=colours,
        raw_entities=len(entities),
    )


def tier1_syntactic(path: str | Path) -> CheckResult:
    try:
        doc = parse_step(path)
    except StepParseError as e:
        return CheckResult("syntactic", False, f"STEP parse failed: {e}")
    return CheckResult(
        "syntactic",
        True,
        f"STEP parsed with {doc.raw_entities} entities",
    )


def tier2_structural(doc: StepDoc, spec: dict[str, Any]) -> list[CheckResult]:
    results: list[CheckResult] = []
    for assertion in spec.get("assertions", []):
        kind = assertion.get("kind")
        if kind == "component_exists":
            name = assertion["component"]
            ok = name in doc.products
            detail = (
                f"PRODUCT '{name}' exists"
                if ok else f"PRODUCT '{name}' missing; have {doc.products}"
            )
            results.append(CheckResult("component_exists", ok, detail))
        elif kind == "component_count":
            have, need = len(doc.products), assertion["min"]
            results.append(CheckResult(
                "component_count",
                have >= need,
                f"STEP has {have} PRODUCTs, need >= {need}",
            ))

    appearance = spec.get("appearance", {})
    if isinstance(appearance, dict):
        for product, name in appearance.items():
            expected = _APPEARANCE_RGB.get(str(name))
            have = doc.colours.get(str(product))
            if expected is None:
                results.append(CheckResult(
                    "appearance",
                    False,
                    f"appearance '{name}' has no RGB table entry",
                ))
            elif have is None:
                results.append(CheckResult(
                    "appearance",
                    False,
                    f"PRODUCT '{product}' has no STEP colour; need {name}",
                ))
            else:
                delta = max(abs(a - b) for a, b in zip(have, expected))
                results.append(CheckResult(
                    "appearance",
                    delta <= _COLOUR_TOL,
                    f"PRODUCT '{product}' colour is {have}, need {name} {expected}",
                ))
    return results


def _entities(text: str) -> dict[str, tuple[str, str]]:
    return {
        match.group("id"): (match.group("kind").upper(), match.group("body"))
        for match in _ENTITY_RE.finditer(text)
    }


def _header(text: str) -> dict[str, str]:
    header_text = text.split("DATA;", 1)[0]
    return {
        "schema": _first_string(header_text.split("FILE_SCHEMA", 1)[-1])
        if "FILE_SCHEMA" in header_text else "",
        "name": _first_string(header_text.split("FILE_NAME", 1)[-1])
        if "FILE_NAME" in header_text else "",
    }


def _first_string(text: str) -> str:
    match = _STRING_RE.search(text)
    return match.group(1).replace("''", "'") if match else ""


def _colour_rgb(body: str) -> tuple[float, float, float]:
    nums = [float(v) for v in re.findall(r"[-+]?\d+(?:\.\d+)?", body)]
    return nums[-3], nums[-2], nums[-1]


def _refs(body: str) -> list[str]:
    return _REF_RE.findall(body)


def _first_ref_matching(body: str, ids: dict[str, Any]) -> str | None:
    for ref in _refs(body):
        if ref in ids:
            return ref
    return None


def _first_reachable_colour(
    start_id: str,
    entities: dict[str, tuple[str, str]],
    colour_by_id: dict[str, tuple[float, float, float]],
) -> tuple[float, float, float] | None:
    seen: set[str] = set()
    stack = [start_id]
    while stack:
        current = stack.pop()
        if current in seen:
            continue
        seen.add(current)
        if current in colour_by_id:
            return colour_by_id[current]
        body = entities.get(current, ("", ""))[1]
        stack.extend(ref for ref in _refs(body) if ref not in seen)
    return None
