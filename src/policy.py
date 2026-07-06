"""Action policy for harness tool execution."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

Approver = Callable[[str, dict], bool]

ALLOW = "allow"
SKIP = "skip"
DENY = "deny"


@dataclass(frozen=True)
class ActionPolicy:
    """Deterministic risk gate for tool calls.

    Safe actions always run. Consequential actions can be auto-approved,
    gated, skipped in dry-run mode, or denied. Critical actions always need a
    live approver unless dry-run skips them.
    """

    mode: str
    approver: Approver | None = None

    @classmethod
    def auto(cls, approver: Approver | None = None) -> "ActionPolicy":
        return cls(mode="auto", approver=approver)

    @classmethod
    def gated(cls, approver: Approver | None = None) -> "ActionPolicy":
        return cls(mode="gated", approver=approver)

    @classmethod
    def dry_run(cls) -> "ActionPolicy":
        return cls(mode="dry_run")

    def decide(self, risk: str, tool: str, params: dict) -> str:
        if risk == "safe":
            return ALLOW
        if self.mode == "dry_run":
            return SKIP
        if self.mode == "auto" and risk != "critical":
            return ALLOW
        if self.approver is not None and self.approver(tool, params):
            return ALLOW
        return DENY
