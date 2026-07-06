from agent import AgentLoop
from policy import ActionPolicy
from tools import ToolDefinition, ToolResult, build_local_tool_registry


class ScriptedLLM:
    last_usage = None

    def __init__(self, replies):
        self.replies = list(replies)
        self.calls = []

    def complete(self, system: str, user: str) -> str:
        self.calls.append((system, user))
        return self.replies.pop(0)


def test_agent_loop_runs_tool_through_registry_and_finishes(tmp_path) -> None:
    (tmp_path / "note.txt").write_text("hello")
    llm = ScriptedLLM([
        '```tool_call\n{"tool": "read", "params": {"path": "note.txt"}}\n```',
        "done",
    ])
    registry = build_local_tool_registry(ActionPolicy.auto(), tmp_path)

    result = AgentLoop(llm, registry, max_turns=3).run("read the note")

    assert result.ok
    assert result.reply == "done"
    assert "hello" in llm.calls[1][1]
    assert [event.kind for event in result.events] == [
        "llm_call",
        "tool_call",
        "llm_call",
    ]


def test_agent_loop_feeds_protocol_errors_back_without_executing(tmp_path) -> None:
    llm = ScriptedLLM([
        (
            '```tool_call\n{"tool": "read", "params": {"path": "a"}}\n```\n'
            '```tool_call\n{"tool": "read", "params": {"path": "b"}}\n```'
        ),
        "fixed",
    ])
    registry = build_local_tool_registry(ActionPolicy.auto(), tmp_path)

    result = AgentLoop(llm, registry, max_turns=3).run("bad protocol")

    assert result.ok
    assert "NOTHING was executed" in llm.calls[1][1]
    assert [event.kind for event in result.events] == [
        "llm_call",
        "protocol_error",
        "llm_call",
    ]


def test_agent_loop_prompts_repair_after_failed_tool_and_empty_reply(tmp_path) -> None:
    llm = ScriptedLLM([
        '```tool_call\n{"tool": "fail_tool", "params": {}}\n```',
        "",
        "cannot repair",
    ])
    registry = build_local_tool_registry(ActionPolicy.auto(), tmp_path)
    registry.register(ToolDefinition(
        name="fail_tool",
        description="always fails",
        input_schema={"type": "object", "required": [], "properties": {}},
        execute=lambda params, context: ToolResult.error("bad geometry"),
        risk="safe",
    ))

    result = AgentLoop(llm, registry, max_turns=4).run("repair after failure")

    assert result.ok is False
    assert "previous tool call failed" in llm.calls[2][1]


def test_agent_loop_allows_corrected_tool_after_failed_tool(tmp_path) -> None:
    llm = ScriptedLLM([
        '```tool_call\n{"tool": "fail_tool", "params": {}}\n```',
        '```tool_call\n{"tool": "read", "params": {"path": "note.txt"}}\n```',
        "done",
    ])
    (tmp_path / "note.txt").write_text("recovered")
    registry = build_local_tool_registry(ActionPolicy.auto(), tmp_path)
    registry.register(ToolDefinition(
        name="fail_tool",
        description="always fails",
        input_schema={"type": "object", "required": [], "properties": {}},
        execute=lambda params, context: ToolResult.error("bad geometry"),
        risk="safe",
    ))

    result = AgentLoop(llm, registry, max_turns=4).run("repair after failure")

    assert result.ok
    assert result.reply == "done"
    assert "bad geometry" in llm.calls[1][1]
    assert "recovered" in llm.calls[2][1]
    assert [event.kind for event in result.events] == [
        "llm_call",
        "tool_call",
        "llm_call",
        "tool_call",
        "llm_call",
    ]


def test_agent_loop_rejects_premature_final_after_failed_tool(tmp_path) -> None:
    llm = ScriptedLLM([
        '```tool_call\n{"tool": "fail_tool", "params": {}}\n```',
        "done",
        "cannot repair",
    ])
    registry = build_local_tool_registry(ActionPolicy.auto(), tmp_path)
    registry.register(ToolDefinition(
        name="fail_tool",
        description="always fails",
        input_schema={"type": "object", "required": [], "properties": {}},
        execute=lambda params, context: ToolResult.error("bad geometry"),
        risk="safe",
    ))

    result = AgentLoop(llm, registry, max_turns=4).run("repair after failure")

    assert result.ok is False
    assert "previous tool call failed" in llm.calls[2][1]
