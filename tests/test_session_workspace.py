import json
import re

from agent import AgentSession
from policy import ActionPolicy
from session import SessionManager
from tools import build_local_tool_registry
from workspace import WorkspaceManager


class ScriptedLLM:
    def __init__(self, replies, usage=None):
        self.replies = list(replies)
        self.last_usage = usage

    def complete(self, system: str, user: str) -> str:
        return self.replies.pop(0)


def _records(path):
    return [json.loads(line) for line in path.read_text().splitlines()]


def test_workspace_and_session_ids_are_cross_linked(tmp_path) -> None:
    ws = WorkspaceManager.create(tmp_path, "Kettle 2L", mode="agent")
    session = SessionManager.create(
        ws.session_path,
        workspace_id=ws.workspace_id,
        mode="agent",
        task="make a kettle",
    )
    ws.link_session(session.session_id)

    manifest = ws.manifest()
    header = _records(ws.session_path)[0]

    assert re.fullmatch(r"kettle_2l-\d{8}-\d{6}-[0-9a-f]{6}", ws.workspace_id)
    assert manifest["workspace_id"] == ws.workspace_id
    assert manifest["session_id"] == session.session_id
    assert header["kind"] == "session_header"
    assert header["workspace_id"] == ws.workspace_id


def test_session_jsonl_records_rebuildable_stats_and_artifacts(tmp_path) -> None:
    session = SessionManager.create(
        tmp_path / "session.jsonl",
        session_id="sess-1",
        workspace_id="ws-1",
        mode="agent",
        task="debug",
    )
    session.llm_call(
        turn=1,
        system="system",
        user="task",
        reply="reply",
        usage={"input_tokens": 7, "output_tokens": 3, "cost_usd": 0.25},
        latency_s=0.1,
    )
    session.tool_call(
        turn=1,
        tool="bash",
        params={"command": "pytest"},
        result="failed",
        ok=False,
        latency_s=0.2,
        sandbox_profile="test",
        execution_context={"cwd": str(tmp_path), "timeout_s": 300},
        artifact_path="artifacts/full.txt",
    )
    session.compaction("middle summarized", protected_turns=2)
    session.artifact("report", "artifacts/report.json")

    reopened = SessionManager.open(session.path)
    stats = reopened.stats()
    records = reopened.records()

    assert [r["kind"] for r in records] == [
        "session_header",
        "llm_call",
        "tool_call",
        "compaction",
        "artifact",
    ]
    assert stats.records == 5
    assert stats.llm_calls == 1
    assert stats.tool_calls == 1
    assert stats.tool_failures == 1
    assert stats.input_tokens == 7
    assert stats.output_tokens == 3
    assert stats.cost_usd == 0.25


def test_workspace_records_stage_and_generated_artifacts(tmp_path) -> None:
    ws = WorkspaceManager.create(tmp_path, "box", mode="workflow", session_id="sess")

    artifact = ws.record_artifact("requirements", {"components": ["body"]})
    generated = ws.generated_dir / "model.py"
    generated.write_text("print('cad')\n")
    ws.record_generated_file(generated, kind="script")
    render = ws.renders_dir / "preview.png"
    render.write_bytes(b"png")
    ws.record_render(render, label="preview")
    ws.finalize("pass", turns=2)

    manifest = ws.manifest()

    assert artifact == ws.artifacts_dir / "requirements.json"
    assert manifest["artifacts"]["requirements"] == "artifacts/requirements.json"
    assert manifest["generated_files"] == [
        {"path": "generated/model.py", "kind": "script"}
    ]
    assert manifest["renders"] == [{"path": "renders/preview.png", "label": "preview"}]
    assert manifest["status"] == "pass"
    assert manifest["ended"]


def test_agent_session_persists_full_run_and_sandbox_context(tmp_path) -> None:
    llm = ScriptedLLM([
        '```tool_call\n{"tool": "write", "params": {"path": "kettle.txt", "content": "plan"}}\n```',
        "Geometry execution unavailable; wrote a plan file.",
    ])
    tools = build_local_tool_registry(ActionPolicy.auto(), tmp_path)
    session = AgentSession.create(
        out_root=tmp_path / "runs",
        task="kettle",
        llm=llm,
        tools=tools,
        system_prompt="system",
        max_turns=3,
    )

    result = session.run("make a kettle")

    assert result.ok
    manifest = session.workspace.manifest()
    records = _records(session.session.path)
    tool = next(r for r in records if r["kind"] == "tool_call")
    assert manifest["status"] == "pass"
    assert manifest["session_id"] == session.session.session_id
    assert records[0]["workspace_id"] == session.workspace.workspace_id
    assert tool["tool"] == "write"
    assert tool["ok"] is True
    assert tool["sandbox_profile"] == "workspace_write"
    assert tool["execution_context"]["writable_roots"] == [str(tmp_path.resolve())]
    assert (tmp_path / "kettle.txt").read_text() == "plan"
    assert manifest["generated_files"] == [
        {"path": str((tmp_path / "kettle.txt").resolve()), "kind": "write"}
    ]
    assert records[-1]["kind"] == "session_end"
