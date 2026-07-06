import json

from agent import AgentSession
from policy import ActionPolicy
from tools import ToolDefinition, ToolExecutionContext, ToolResult, build_local_tool_registry
from workflow import WorkflowContext, text_to_cad_workflow


class ScriptedLLM:
    last_usage = None

    def __init__(self, replies):
        self.replies = list(replies)
        self.calls = []

    def complete(self, system: str, user: str) -> str:
        self.calls.append((system, user))
        return self.replies.pop(0)


def _agent_session(tmp_path, replies, tools):
    return AgentSession.create(
        out_root=tmp_path / "runs",
        task="kettle",
        llm=ScriptedLLM(replies),
        tools=tools,
        system_prompt="system",
        max_turns=4,
    )


def test_text_to_cad_workflow_runs_local_tools_only_kettle(tmp_path) -> None:
    tools = build_local_tool_registry(ActionPolicy.auto(), tmp_path)
    agent_session = _agent_session(
        tmp_path,
        [
            '```tool_call\n{"tool": "write", "params": {"path": "kettle_plan.py", "content": "# kettle plan"}}\n```',
            "Wrote a local plan. Geometry execution and verification are unavailable.",
        ],
        tools,
    )
    workflow = text_to_cad_workflow(tools)

    results = workflow.run(WorkflowContext(
        task="help me design a 2L white kettle with base cap and handle",
        agent_session=agent_session,
        tools=tools,
    ))

    manifest = agent_session.workspace.manifest()
    artifacts = manifest["artifacts"]

    assert [result.name for result in results] == [
        "requirements",
        "plan",
        "develop",
        "output",
    ]
    assert manifest["status"] == "pass"
    assert (tmp_path / "kettle_plan.py").read_text() == "# kettle plan"
    assert set(artifacts) == {
        "requirements",
        "plan",
        "develop",
        "final-report",
        "output",
        "workflow-results",
    }
    plan = json.loads((agent_session.workspace.dir / artifacts["plan"]).read_text())
    output = json.loads((agent_session.workspace.dir / artifacts["output"]).read_text())
    assert plan["geometry_execution"] == "unavailable"
    assert output["verification_status"] == "unavailable"


def test_text_to_cad_workflow_runs_optional_fake_verifier(tmp_path) -> None:
    tools = build_local_tool_registry(ActionPolicy.auto(), tmp_path)
    seen = {}

    def verify(params: dict, context: ToolExecutionContext) -> ToolResult:
        seen.update(params)
        return ToolResult.success("fake verifier passed")

    tools.register(ToolDefinition(
        name="verify_step",
        description="fake verifier",
        input_schema={
            "type": "object",
            "required": ["step_path"],
            "properties": {"step_path": {"type": "string"}, "spec": {"type": "object"}},
        },
        execute=verify,
        risk="safe",
        sandbox_profile="read_only",
    ))
    agent_session = _agent_session(
        tmp_path,
        [
            "Developed with fake CAD tool context.",
        ],
        tools,
    )
    step = tmp_path / "model.step"
    step.write_text("placeholder")
    agent_session.workspace.record_generated_file(step, kind="step")

    results = text_to_cad_workflow(tools).run(WorkflowContext(
        task="kettle",
        agent_session=agent_session,
        tools=tools,
    ))

    manifest = agent_session.workspace.manifest()
    verify_artifact = json.loads(
        (agent_session.workspace.dir / manifest["artifacts"]["verify"]).read_text()
    )

    assert [result.name for result in results] == [
        "requirements",
        "plan",
        "develop",
        "verify",
        "output",
    ]
    assert seen["step_path"] == str(step)
    assert verify_artifact["ok"] is True
    assert verify_artifact["result"] == "fake verifier passed"


def test_text_to_cad_workflow_fails_when_step_required_but_only_stl_recorded(tmp_path) -> None:
    tools = build_local_tool_registry(ActionPolicy.auto(), tmp_path)

    def export(params: dict, context: ToolExecutionContext) -> ToolResult:
        context.artifact_recorder(tmp_path / "model.stl", "stl")
        return ToolResult.success("exported stl", artifact_path=tmp_path / "model.stl")

    tools.register(ToolDefinition(
        name="export",
        description="fake export",
        input_schema={"type": "object", "required": [], "properties": {}},
        execute=export,
        risk="consequential",
        sandbox_profile="workspace_write",
    ))
    agent_session = _agent_session(
        tmp_path,
        [
            '```tool_call\n{"tool": "export", "params": {}}\n```',
            "Complete with STL only.",
        ],
        tools,
    )

    results = text_to_cad_workflow(tools).run(WorkflowContext(
        task="output a STEP file",
        agent_session=agent_session,
        tools=tools,
    ))

    assert [result.name for result in results] == ["requirements", "plan", "develop"]
    assert results[-1].ok is False
    assert "STEP" in results[-1].detail
    assert agent_session.workspace.manifest()["status"] == "fail"


def test_text_to_cad_workflow_contract_requires_named_coloured_step_export_and_render(tmp_path) -> None:
    tools = build_local_tool_registry(ActionPolicy.auto(), tmp_path)
    llm = ScriptedLLM(["Cannot execute CAD here."])
    agent_session = AgentSession.create(
        out_root=tmp_path / "runs",
        task="kettle",
        llm=llm,
        tools=tools,
        system_prompt="system",
        max_turns=1,
    )

    text_to_cad_workflow(tools).run(WorkflowContext(
        task=(
            "Design an electric kettle with separate power_base, body, handle, "
            "spout, and lid. Use brushed stainless steel and matte black plastic "
            "appearance. Output a STEP file."
        ),
        agent_session=agent_session,
        tools=tools,
    ))

    develop_prompt = llm.calls[0][1]
    assert "assign explicit per-component CAD colours" in develop_prompt
    assert "set each named object's `.color`" in develop_prompt
    assert "render the assembly before export" in develop_prompt
    assert "object_name=\"*\"" in develop_prompt
    assert "preserve product names and per-component colours" in develop_prompt
    assert "do not export only an aggregate compound" in develop_prompt
