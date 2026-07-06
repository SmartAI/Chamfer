"""Passive proof ledger for debug, test, build, and verify evidence."""

from __future__ import annotations

import json
import time
from dataclasses import asdict, dataclass
from pathlib import Path


EVIDENCE_KINDS = frozenset(
    {
        "test",
        "build",
        "lint",
        "format",
        "debug",
        "cad_execute",
        "cad_verify",
        "render_check",
    }
)


@dataclass(frozen=True)
class EvidenceRecord:
    command: str
    kind: str
    scope: str
    status: str
    exit_code: int | None
    cwd: str
    changed_paths: tuple[str, ...]
    timestamp: float
    output_summary: str
    full_output_artifact: str | None = None


class EvidenceLedger:
    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def record(
        self,
        *,
        command: str,
        kind: str,
        scope: str,
        status: str,
        exit_code: int | None,
        cwd: str | Path,
        changed_paths: tuple[str, ...] = (),
        output_summary: str = "",
        full_output_artifact: str | Path | None = None,
        timestamp: float | None = None,
    ) -> EvidenceRecord:
        if kind not in EVIDENCE_KINDS:
            raise ValueError(f"unknown evidence kind: {kind}")
        record = EvidenceRecord(
            command=command,
            kind=kind,
            scope=scope,
            status=status,
            exit_code=exit_code,
            cwd=str(cwd),
            changed_paths=tuple(changed_paths),
            timestamp=timestamp or time.time(),
            output_summary=output_summary,
            full_output_artifact=str(full_output_artifact) if full_output_artifact else None,
        )
        with self.path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(asdict(record), default=str) + "\n")
        return record

    def records(self) -> list[EvidenceRecord]:
        if not self.path.exists():
            return []
        return [
            EvidenceRecord(**json.loads(line))
            for line in self.path.read_text(encoding="utf-8").splitlines()
        ]

    def latest(
        self,
        *,
        kind: str | None = None,
        scope: str | None = None,
        status: str | None = None,
    ) -> EvidenceRecord | None:
        candidates = self.records()
        if kind is not None:
            candidates = [record for record in candidates if record.kind == kind]
        if scope is not None:
            candidates = [record for record in candidates if record.scope == scope]
        if status is not None:
            candidates = [record for record in candidates if record.status == status]
        return max(candidates, key=lambda record: record.timestamp, default=None)

    def is_fresh_for(self, record: EvidenceRecord, paths: list[str | Path]) -> bool:
        for path in paths:
            p = Path(path)
            if p.exists() and p.stat().st_mtime > record.timestamp:
                return False
        return True

    def verification_gap(self, paths: list[str | Path], *, kind: str = "test") -> str | None:
        latest = self.latest(kind=kind, status="pass")
        if latest is None:
            return f"no passing {kind} evidence recorded"
        if not self.is_fresh_for(latest, paths):
            return f"latest passing {kind} evidence is stale"
        return None


def classify_command(command: str) -> str:
    lowered = command.lower()
    if "pytest" in lowered or " test" in lowered or lowered.startswith("test "):
        return "test"
    if "ruff" in lowered or "mypy" in lowered or "eslint" in lowered:
        return "lint"
    if "black" in lowered or "prettier" in lowered or "format" in lowered:
        return "format"
    if "build" in lowered or "hatch" in lowered:
        return "build"
    if "verify" in lowered:
        return "cad_verify"
    if "render" in lowered or "screenshot" in lowered:
        return "render_check"
    return "debug"


def summarize_output(output: str, limit: int = 500) -> str:
    lines = [line for line in output.strip().splitlines() if line.strip()]
    summary = "\n".join(lines[-5:])
    if len(summary) > limit:
        summary = summary[-limit:]
    return summary
