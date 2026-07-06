"""Tiered STEP verification for Chamfer."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from . import CheckResult, Report
from .spec import validate_spec
from .step_reader import StepParseError, parse_step, tier2_structural


class TieredVerifier:
    def __init__(self, *, allow_geometric: bool | None = None) -> None:
        self.allow_geometric = bool(allow_geometric)

    def capabilities(self) -> set[str]:
        caps = {"syntactic", "structural"}
        if self.allow_geometric:
            caps.add("geometric")
        return caps

    def verify(self, step_path: str | Path, spec: dict[str, Any]) -> Report:
        validate_spec({"assertions": spec.get("assertions", [])})
        try:
            doc = parse_step(step_path)
        except StepParseError as e:
            return Report((
                CheckResult("syntactic", False, f"STEP parse failed: {e}"),
            ), tier_reached="syntactic")

        results: list[CheckResult] = [
            CheckResult(
                "syntactic",
                True,
                f"STEP parsed with {doc.raw_entities} entities",
            )
        ]
        structural = tier2_structural(doc, spec)
        results.extend(structural)
        if any(not result.ok for result in structural):
            return Report(tuple(results), tier_reached="structural")
        tier = "geometric" if self.allow_geometric else "structural"
        return Report(tuple(results), tier_reached=tier)
