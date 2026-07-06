"""Small observability helpers for the harness core."""

from __future__ import annotations

import json
import time
from pathlib import Path


class JsonlTrace:
    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def event(self, kind: str, **payload) -> None:
        record = {"ts": round(time.time(), 3), "kind": kind, **payload}
        with self.path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, default=str) + "\n")


class ObservedLLM:
    def __init__(self, inner, trace: JsonlTrace, purpose: str = "agent") -> None:
        self._inner = inner
        self._trace = trace
        self._purpose = purpose
        self.model = getattr(inner, "model", "")
        self.stateful = bool(getattr(inner, "stateful", False))

    @property
    def last_usage(self):
        return getattr(self._inner, "last_usage", None)

    def complete(self, system: str, user: str) -> str:
        start = time.time()
        reply = self._inner.complete(system, user)
        self._trace.event(
            "llm_call",
            purpose=self._purpose,
            model=str(self.model),
            latency_s=round(time.time() - start, 3),
            input_chars=len(user),
            output_chars=len(reply),
            usage=self.last_usage or {},
        )
        return reply

    def send(self, text: str) -> str:
        start = time.time()
        reply = self._inner.send(text)
        self._trace.event(
            "llm_call",
            purpose=self._purpose,
            model=str(self.model),
            latency_s=round(time.time() - start, 3),
            input_chars=len(text),
            output_chars=len(reply),
            usage=self.last_usage or {},
        )
        return reply
