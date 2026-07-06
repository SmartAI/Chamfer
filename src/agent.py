"""Backend-agnostic bounded agent loop."""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

from protocol import ProtocolError, parse_reply
from session import SessionManager
from tools import ToolRegistry
from workspace import WorkspaceManager


class LLM(Protocol):
    last_usage: dict | None

    def complete(self, system: str, user: str) -> str:
        ...


@dataclass(frozen=True)
class AgentEvent:
    kind: str
    data: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class AgentResult:
    ok: bool
    reply: str
    turns: int
    events: tuple[AgentEvent, ...] = ()


class AgentLoop:
    def __init__(
        self,
        llm: LLM,
        tools: ToolRegistry,
        *,
        system_prompt: str = "",
        max_turns: int = 40,
        echo: Callable[[str], None] | None = None,
        session: SessionManager | None = None,
    ) -> None:
        self._llm = llm
        self._tools = tools
        self._system = system_prompt
        self._max_turns = max_turns
        self._echo = echo or (lambda text: None)
        self._session = session

    def run(self, task: str) -> AgentResult:
        stateful = bool(getattr(self._llm, "stateful", False))
        transcript: list[str] = [f"[task]\n{task}"]
        pending = f"{self._system}\n\n[task]\n{task}" if stateful else ""
        events: list[AgentEvent] = []
        if self._session is not None:
            self._session.message("user", task, turn=0)
        last_tool_ok: bool | None = None

        def emit(kind: str, **data) -> None:
            event = AgentEvent(kind=kind, data=data)
            events.append(event)

        for turn in range(1, self._max_turns + 1):
            start = time.time()
            try:
                if stateful:
                    reply = self._llm.send(pending)
                else:
                    pending = "\n\n".join(transcript)
                    reply = self._llm.complete(self._system, pending)
            except Exception as e:
                latency_s = round(time.time() - start, 3)
                detail = f"LLM call failed on turn {turn}: {e}"
                emit("llm_error", turn=turn, latency_s=latency_s, detail=detail)
                if self._session is not None:
                    self._session.append(
                        "llm_error",
                        turn=turn,
                        latency_s=latency_s,
                        detail=detail,
                    )
                return AgentResult(ok=False, reply=detail, turns=turn, events=tuple(events))
            usage = getattr(self._llm, "last_usage", None) or {}
            latency_s = round(time.time() - start, 3)
            emit(
                "llm_call",
                turn=turn,
                latency_s=latency_s,
                output_chars=len(reply),
                usage={k: usage[k] for k in sorted(usage)},
            )
            if self._session is not None:
                self._session.llm_call(
                    turn=turn,
                    system=self._system,
                    user=pending,
                    reply=reply,
                    usage=usage,
                    latency_s=latency_s,
                )
                self._session.message("assistant", reply, turn=turn)
            transcript.append(f"[assistant]\n{reply}")
            self._echo(reply)
            try:
                call = parse_reply(reply)
            except ProtocolError as e:
                emit("protocol_error", turn=turn, detail=str(e))
                feedback = (
                    f"[tool result for protocol]\nerror: {e}\n"
                    "NOTHING was executed. Re-send your first intended call "
                    "as exactly ONE tool_call block; later calls go in later turns."
                )
                if self._session is not None:
                    self._session.append("protocol_error", turn=turn, detail=str(e))
                    self._session.message("tool", feedback, turn=turn, tool="protocol")
                transcript.append(feedback)
                pending = feedback
                continue
            if call is None:
                if not reply.strip():
                    if last_tool_ok is False and turn < self._max_turns:
                        feedback = (
                            "[tool result for repair]\n"
                            "error: your previous tool call failed and your last reply was empty. "
                            "Do not finish yet. Send exactly one corrected tool_call that repairs "
                            "the failure, or provide a non-empty final answer only if the task is "
                            "truly impossible."
                        )
                        if self._session is not None:
                            self._session.append("repair_prompt", turn=turn, detail=feedback)
                            self._session.message("tool", feedback, turn=turn, tool="repair")
                        transcript.append(feedback)
                        pending = feedback
                        continue
                    return AgentResult(
                        ok=False,
                        reply="LLM returned an empty final reply",
                        turns=turn,
                        events=tuple(events),
                    )
                if last_tool_ok is False:
                    if turn < self._max_turns:
                        feedback = (
                            "[tool result for repair]\n"
                            "error: your previous tool call failed. The stage is not complete. "
                            "Send exactly one corrected tool_call that repairs the failure, or "
                            "explain why the task is impossible."
                        )
                        if self._session is not None:
                            self._session.append("repair_prompt", turn=turn, detail=feedback)
                            self._session.message("tool", feedback, turn=turn, tool="repair")
                        transcript.append(feedback)
                        pending = feedback
                        continue
                    return AgentResult(
                        ok=False,
                        reply=(
                            "stage ended immediately after a failed tool call; "
                            f"final reply was: {reply}"
                        ),
                        turns=turn,
                        events=tuple(events),
                    )
                return AgentResult(
                    ok=True,
                    reply=reply,
                    turns=turn,
                    events=tuple(events),
                )
            tool_start = time.time()
            result = self._tools.execute_result(call.tool, call.params)
            last_tool_ok = result.ok
            tool_latency_s = round(time.time() - tool_start, 3)
            emit(
                "tool_call",
                turn=turn,
                tool=call.tool,
                ok=result.ok,
                latency_s=tool_latency_s,
                artifact_path=str(result.artifact_path) if result.artifact_path else None,
                sandbox_profile=result.sandbox_profile,
            )
            if self._session is not None:
                self._session.tool_call(
                    turn=turn,
                    tool=call.tool,
                    params=call.params,
                    result=result.output,
                    ok=result.ok,
                    latency_s=tool_latency_s,
                    sandbox_profile=result.sandbox_profile,
                    execution_context=result.execution_context,
                    artifact_path=str(result.artifact_path) if result.artifact_path else None,
                )
                self._session.message("tool", result.output, turn=turn, tool=call.tool)
            self._echo(f"[{call.tool}] {result.output[:200]}")
            transcript.append(f"[tool result for {call.tool}]\n{result.output}")
            pending = transcript[-1]

        detail = f"Agent reached max turns ({self._max_turns}) before completing the stage"
        emit("max_turns", turns=self._max_turns, detail=detail)
        if self._session is not None:
            self._session.append("max_turns", turns=self._max_turns, detail=detail)
        return AgentResult(
            ok=False,
            reply=detail,
            turns=self._max_turns,
            events=tuple(events),
        )


class AgentSession:
    """High-level lifecycle facade for one harness run."""

    def __init__(
        self,
        *,
        workspace: WorkspaceManager,
        session: SessionManager,
        llm: LLM,
        tools: ToolRegistry,
        system_prompt: str = "",
        max_turns: int = 40,
        echo: Callable[[str], None] | None = None,
    ) -> None:
        self.workspace = workspace
        self.session = session
        self.llm = llm
        self.tools = tools
        self.system_prompt = system_prompt
        self.max_turns = max_turns
        self.echo = echo

    @classmethod
    def create(
        cls,
        *,
        out_root: str | Path,
        task: str,
        llm: LLM,
        tools: ToolRegistry,
        system_prompt: str = "",
        mode: str = "agent",
        max_turns: int = 40,
        metadata: dict | None = None,
        echo: Callable[[str], None] | None = None,
    ) -> AgentSession:
        workspace = WorkspaceManager.create(out_root, task, mode=mode)
        session = SessionManager.create(
            workspace.session_path,
            workspace_id=workspace.workspace_id,
            mode=mode,
            task=task,
            metadata=metadata or {},
        )
        workspace.link_session(session.session_id)
        tools.set_artifact_recorder(
            lambda path, kind: workspace.record_generated_file(path, kind=kind)
        )
        return cls(
            workspace=workspace,
            session=session,
            llm=llm,
            tools=tools,
            system_prompt=system_prompt,
            max_turns=max_turns,
            echo=echo,
        )

    def prompt(self, task: str) -> AgentResult:
        return self.run(task)

    def run(self, task: str) -> AgentResult:
        result = self.run_stage(task, stage_name="agent")
        self.finish(result)
        return result

    def run_stage(self, task: str, *, stage_name: str) -> AgentResult:
        self.session.append("stage_start", stage=stage_name, task=task)
        loop = AgentLoop(
            self.llm,
            self.tools,
            system_prompt=self.system_prompt,
            max_turns=self.max_turns,
            session=self.session,
            echo=self.echo,
        )
        result = loop.run(task)
        self.session.append(
            "stage_end",
            stage=stage_name,
            ok=result.ok,
            turns=result.turns,
            reply=result.reply,
        )
        return result

    def finish(self, result: AgentResult) -> None:
        self.workspace.finalize(
            "pass" if result.ok else "fail",
            turns=result.turns,
            final_reply=result.reply,
        )
        self.session.append(
            "session_end",
            ok=result.ok,
            turns=result.turns,
            final_reply=result.reply,
        )

    def resume(self, task: str) -> AgentResult:
        self.session.append("resume", task=task)
        return self.run(task)

    def stop(self, reason: str) -> None:
        self.workspace.finalize("stopped", reason=reason)
        self.session.append("session_end", ok=False, stopped=True, reason=reason)

    def compact(self, summary: str, protected_turns: int = 2) -> None:
        self.session.compaction(summary, protected_turns)

    def stats(self):
        return self.session.stats()
