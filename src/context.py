"""Context accounting and simple compaction support."""

from __future__ import annotations

from dataclasses import dataclass, field

from session import SessionManager


@dataclass(frozen=True)
class ContextTurn:
    role: str
    content: str


@dataclass
class ContextEngine:
    max_tokens: int = 32_000
    compact_at: float = 0.8
    session: SessionManager | None = None
    turns: list[ContextTurn] = field(default_factory=list)
    input_tokens: int = 0
    output_tokens: int = 0

    def add_turn(self, role: str, content: str) -> None:
        self.turns.append(ContextTurn(role, content))

    def record_usage(self, usage: dict | None) -> None:
        if not usage:
            return
        self.input_tokens += int(usage.get("input_tokens") or 0)
        self.output_tokens += int(usage.get("output_tokens") or 0)

    @property
    def total_tokens(self) -> int:
        return self.input_tokens + self.output_tokens

    def should_compact(self) -> bool:
        return self.total_tokens >= int(self.max_tokens * self.compact_at)

    def compact(self, *, protect_first: int = 1, protect_latest: int = 2) -> str:
        if len(self.turns) <= protect_first + protect_latest:
            summary = "No middle context to compact."
        else:
            first = self.turns[:protect_first]
            middle = self.turns[protect_first:-protect_latest]
            latest = self.turns[-protect_latest:]
            summary = _summarize_middle(middle)
            self.turns = [
                *first,
                ContextTurn("summary", summary),
                *latest,
            ]
        if self.session is not None:
            self.session.compaction(summary, protected_turns=protect_first + protect_latest)
        return summary


def _summarize_middle(turns: list[ContextTurn]) -> str:
    count = len(turns)
    chars = sum(len(turn.content) for turn in turns)
    roles = ", ".join(turn.role for turn in turns[:6])
    if count > 6:
        roles += ", ..."
    return f"Compacted {count} middle turn(s), {chars} chars. Roles: {roles}."
