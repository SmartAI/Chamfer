"""Append-only harness session transcript."""

from __future__ import annotations

import json
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

MAX_FIELD_CHARS = 100_000


@dataclass(frozen=True)
class SessionStats:
    records: int
    llm_calls: int
    tool_calls: int
    tool_failures: int
    input_tokens: int
    output_tokens: int
    cost_usd: float


class SessionManager:
    """A JSONL session log that can be rebuilt without in-memory state."""

    def __init__(self, path: str | Path, session_id: str) -> None:
        self.path = Path(path)
        self.session_id = session_id
        self.path.parent.mkdir(parents=True, exist_ok=True)

    @classmethod
    def create(
        cls,
        path: str | Path,
        *,
        session_id: str | None = None,
        workspace_id: str | None = None,
        mode: str = "agent",
        task: str = "",
        metadata: dict | None = None,
    ) -> SessionManager:
        session = cls(path, session_id or uuid.uuid4().hex[:12])
        session.header(workspace_id=workspace_id, mode=mode, task=task, metadata=metadata or {})
        return session

    @classmethod
    def open(cls, path: str | Path) -> SessionManager:
        records = read_records(path)
        if not records:
            raise ValueError(f"session log is empty: {path}")
        header = records[0]
        if header.get("kind") != "session_header":
            raise ValueError(f"session log missing session_header: {path}")
        return cls(path, str(header["session_id"]))

    def header(
        self,
        *,
        workspace_id: str | None,
        mode: str,
        task: str,
        metadata: dict,
    ) -> None:
        self.append(
            "session_header",
            session_id=self.session_id,
            workspace_id=workspace_id,
            mode=mode,
            task=task,
            metadata=metadata,
        )

    def append(self, kind: str, **payload) -> dict:
        record = {
            "ts": round(time.time(), 3),
            "session_id": self.session_id,
            "kind": kind,
        }
        truncated = False
        for key, value in payload.items():
            clean, did_truncate = _truncate_value(value)
            record[key] = clean
            truncated = truncated or did_truncate
        if truncated:
            record["truncated"] = True
        with self.path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False, default=str) + "\n")
        return record

    def message(self, role: str, content: str, **payload) -> None:
        self.append("message", role=role, content=content, **payload)

    def llm_call(
        self,
        *,
        turn: int,
        system: str,
        user: str,
        reply: str,
        usage: dict | None,
        latency_s: float,
    ) -> None:
        self.append(
            "llm_call",
            turn=turn,
            system=system,
            user=user,
            reply=reply,
            usage=usage or {},
            latency_s=latency_s,
        )

    def tool_call(
        self,
        *,
        turn: int,
        tool: str,
        params: dict,
        result: str,
        ok: bool,
        latency_s: float,
        sandbox_profile: str | None = None,
        execution_context: dict | None = None,
        artifact_path: str | None = None,
    ) -> None:
        self.append(
            "tool_call",
            turn=turn,
            tool=tool,
            params=params,
            result=result,
            ok=ok,
            latency_s=latency_s,
            sandbox_profile=sandbox_profile,
            execution_context=execution_context,
            artifact_path=artifact_path,
        )

    def model_change(self, model: str, reason: str = "") -> None:
        self.append("model_change", model=model, reason=reason)

    def compaction(self, summary: str, protected_turns: int) -> None:
        self.append("compaction", summary=summary, protected_turns=protected_turns)

    def artifact(self, name: str, path: str, kind: str = "artifact") -> None:
        self.append("artifact", name=name, path=path, artifact_kind=kind)

    def records(self) -> list[dict]:
        return read_records(self.path)

    def stats(self) -> SessionStats:
        records = self.records()
        llm_calls = [r for r in records if r.get("kind") == "llm_call"]
        tool_calls = [r for r in records if r.get("kind") == "tool_call"]
        input_tokens = output_tokens = 0
        cost_usd = 0.0
        for record in llm_calls:
            usage = record.get("usage") or {}
            input_tokens += int(usage.get("input_tokens") or 0)
            output_tokens += int(usage.get("output_tokens") or 0)
            cost_usd += float(usage.get("cost_usd") or 0.0)
        return SessionStats(
            records=len(records),
            llm_calls=len(llm_calls),
            tool_calls=len(tool_calls),
            tool_failures=sum(1 for r in tool_calls if not r.get("ok")),
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cost_usd=round(cost_usd, 6),
        )


def read_records(path: str | Path) -> list[dict]:
    p = Path(path)
    if not p.exists():
        return []
    return [json.loads(line) for line in p.read_text(encoding="utf-8").splitlines()]


def _truncate_value(value: Any) -> tuple[Any, bool]:
    if isinstance(value, str) and len(value) > MAX_FIELD_CHARS:
        return value[:MAX_FIELD_CHARS], True
    if isinstance(value, dict):
        clean = {}
        truncated = False
        for key, item in value.items():
            clean_item, item_truncated = _truncate_value(item)
            clean[key] = clean_item
            truncated = truncated or item_truncated
        return clean, truncated
    if isinstance(value, list):
        clean_items = []
        truncated = False
        for item in value:
            clean_item, item_truncated = _truncate_value(item)
            clean_items.append(clean_item)
            truncated = truncated or item_truncated
        return clean_items, truncated
    return value, False
