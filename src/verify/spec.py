"""Small assertion-spec validator for Chamfer's STEP verifier."""

from __future__ import annotations

from typing import Any

from tools import validate_params

KNOWN_KINDS = frozenset({"component_exists", "component_count"})


class SpecError(ValueError):
    """Raised when an assertion spec is malformed."""


ASSERTION_SCHEMAS: dict[str, dict[str, Any]] = {
    "component_exists": {
        "type": "object",
        "required": ["component"],
        "properties": {"component": {"type": "string"}},
    },
    "component_count": {
        "type": "object",
        "required": ["min"],
        "properties": {"min": {"type": "number", "exclusiveMinimum": 0}},
    },
}


def validate_spec(spec: dict[str, Any]) -> None:
    if not isinstance(spec, dict):
        raise SpecError("assertion spec must be an object")
    assertions = spec.get("assertions", [])
    if not isinstance(assertions, list):
        raise SpecError("'assertions' must be a list")
    for item in assertions:
        kind = item.get("kind") if isinstance(item, dict) else None
        if kind not in KNOWN_KINDS:
            raise SpecError(
                f"unknown assertion kind {kind!r}; known: {sorted(KNOWN_KINDS)}"
            )
        params = {key: value for key, value in item.items() if key != "kind"}
        problems = validate_params(ASSERTION_SCHEMAS[kind], params)
        if problems:
            raise SpecError(f"invalid assertion {kind!r}: " + "; ".join(problems))
