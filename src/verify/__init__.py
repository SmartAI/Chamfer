"""Deterministic STEP verification primitives for Chamfer."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class CheckResult:
    kind: str
    ok: bool
    detail: str


@dataclass(frozen=True)
class Report:
    results: tuple[CheckResult, ...]
    tier_reached: str = "structural"

    @property
    def ok(self) -> bool:
        return all(result.ok for result in self.results)

    def failures(self) -> list[str]:
        return [
            f"{result.kind}: {result.detail}"
            for result in self.results
            if not result.ok
        ]

    def to_dict(self) -> dict:
        return {
            "ok": self.ok,
            "tier_reached": self.tier_reached,
            "results": [
                {"kind": result.kind, "ok": result.ok, "detail": result.detail}
                for result in self.results
            ],
        }
