import ast
import json
import sys
from pathlib import Path

from cli import main
from llm import normalize_usage
from mcp_config import McpServerConfig
from mcp_tools import register_mcp_tools
from policy import ActionPolicy
from tools import ToolRegistry, build_local_tool_registry
from verify.tool import register_verify_tools


def test_harness_cli_runs_text_to_cad_workflow_with_scripted_llm(tmp_path, monkeypatch, capsys) -> None:
    monkeypatch.chdir(tmp_path)
    replies = tmp_path / "replies"
    replies.mkdir()
    (replies / "response_1.json").write_text(
        '```tool_call\n{"tool": "write", "params": {"path": "kettle.md", "content": "plan"}}\n```'
    )
    (replies / "response_2.json").write_text(
        "Wrote plan; geometry execution unavailable."
    )

    rc = main([
        "run",
        "design a 2L white kettle",
        "--scripted-dir",
        str(replies),
        "--out",
        str(tmp_path / "runs"),
    ])

    assert rc == 0
    assert "DONE" in capsys.readouterr().out
    workspace = next((tmp_path / "runs").glob("design_a_2l_white_kettle-*"))
    manifest = json.loads((workspace / "manifest.json").read_text())
    assert manifest["status"] == "pass"
    assert "workflow-results" in manifest["artifacts"]
    assert (tmp_path / "kettle.md").read_text() == "plan"


def test_harness_cli_discovers_project_build123d_mcp_config(
    tmp_path,
    monkeypatch,
    capsys,
) -> None:
    monkeypatch.chdir(tmp_path)
    fake_server = Path(__file__).resolve().parents[0] / "fake_stdio_mcp.py"
    (tmp_path / ".mcp.json").write_text(json.dumps({
        "mcpServers": {
            "build123d": {
                "command": sys.executable,
                "args": [str(fake_server)],
                "capabilities": ["build123d"],
            }
        }
    }))
    replies = tmp_path / "replies"
    replies.mkdir()
    (replies / "response_1.json").write_text(
        '```tool_call\n{"tool": "make_box", "params": {}}\n```'
    )
    (replies / "response_2.json").write_text("External build123d MCP tool ran.")

    rc = main([
        "run",
        "design a small block with build123d",
        "--scripted-dir",
        str(replies),
        "--out",
        str(tmp_path / "runs"),
    ])

    assert rc == 0
    assert "DONE" in capsys.readouterr().out
    workspace = next((tmp_path / "runs").glob("design_a_small_block_with_build123d-*"))
    plan = json.loads((workspace / "artifacts" / "plan.json").read_text())
    session = (workspace / "session.jsonl").read_text()
    assert "make_box" in plan["available_tools"]
    assert plan["geometry_execution"] == "available"
    assert '"tool": "make_box"' in session
    assert "mcp://build123d/instructions" in session
    assert "Fake build123d MCP instructions" in session


def test_cli_provider_openai_requires_env_key(tmp_path, monkeypatch, capsys) -> None:
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)

    rc = main(["run", "design a part", "--provider", "openai"])

    assert rc == 2
    assert "OPENAI_API_KEY" in capsys.readouterr().err


def test_cli_requires_provider_or_scripted_dir(tmp_path, monkeypatch, capsys) -> None:
    monkeypatch.chdir(tmp_path)

    rc = main(["run", "design a part"])

    assert rc == 2
    assert "no provider selected" in capsys.readouterr().err


def test_cli_copies_generated_step_to_output_path(tmp_path, monkeypatch, capsys) -> None:
    monkeypatch.chdir(tmp_path)
    replies = tmp_path / "replies"
    replies.mkdir()
    (replies / "response_1.json").write_text(
        '```tool_call\n{"tool": "write", "params": '
        '{"path": "part.txt", "content": "plan"}}\n```'
    )
    (replies / "response_2.json").write_text("Wrote plan.")

    # Patch the workflow so the run passes and records a generated STEP file,
    # exercising the --output delivery path without a real CAD backend.
    import cli as cli_mod
    from workflow import StageResult

    real_run = cli_mod.text_to_cad_workflow

    def fake_workflow(tools):
        runner = real_run(tools)

        def run(context):
            step = context.workspace.generated_dir / "model.step"
            step.write_text("ISO-10303-21;\n")
            context.workspace.record_generated_file(step, kind="step")
            return [StageResult("develop", True)]

        runner.run = run  # type: ignore[assignment]
        return runner

    monkeypatch.setattr(cli_mod, "text_to_cad_workflow", fake_workflow)

    dest = tmp_path / "exports" / "final" / "kettle.step"
    rc = main([
        "run",
        "design a step part",
        "--provider",
        "scripted",
        "--scripted-dir",
        str(replies),
        "--out",
        str(tmp_path / "runs"),
        "--output",
        str(dest),
    ])

    out = capsys.readouterr().out
    assert rc == 0
    assert dest.is_file()
    assert dest.read_text().startswith("ISO-10303-21;")
    assert f"output: {dest}" in out


def test_llm_usage_normalization_keeps_provider_neutral_keys() -> None:
    usage = normalize_usage({
        "prompt_tokens": 10,
        "completion_tokens": 5,
        "cache_read_input_tokens": 3,
    }, cost_usd="0.125")

    assert usage == {
        "input_tokens": 10,
        "output_tokens": 5,
        "cache_read_tokens": 3,
        "cost_usd": 0.125,
    }


def test_verify_capability_registers_optional_tool_and_checks_step_fixture(tmp_path) -> None:
    registry = build_local_tool_registry(ActionPolicy.auto(), Path.cwd())
    names = register_verify_tools(registry)

    result = registry.execute_result(
        "verify_step",
        {
            "step_path": "tests/verify/fixtures/valid_named_coloured.step",
            "spec": {"assertions": [{"kind": "component_count", "min": 1}]},
        },
    )

    assert names == ["verify_step"]
    assert result.ok
    assert "component_count" in result.output


def test_mcp_bridge_registers_external_server_tools(monkeypatch) -> None:
    import mcp_tools as mcp_mod

    class FakeClient:
        def __init__(self, argv, *, env=None, cwd=None):
            self.argv = argv
            self.env = env
            self.cwd = cwd

        def rpc(self, method, params):
            if method == "resources/list":
                return {"resources": [{
                    "uri": "build123d://quickref",
                    "name": "quickref",
                    "mimeType": "text/plain",
                }]}
            assert method == "tools/list"
            return {"tools": [{
                "name": "build123d_execute",
                "description": "execute build123d",
                "inputSchema": {"type": "object", "required": [], "properties": {}},
            }, {
                "name": "export",
                "description": "export model",
                "inputSchema": {
                    "type": "object",
                    "required": ["filename"],
                    "properties": {
                        "filename": {"type": "string"},
                        "format": {"type": "string"},
                    },
                },
            }]}

        def call_tool(self, name, params):
            return {"content": [{"type": "text", "text": f"{name} ok"}]}

        def list_resources(self):
            return self.rpc("resources/list", {})["resources"]

        def read_resource(self, uri):
            return {"contents": [{"uri": uri, "mimeType": "text/plain", "text": "quickref"}]}

        def server_instructions(self):
            return "Use persistent build123d session; render before export."

    monkeypatch.setattr(mcp_mod, "StdioMcpClient", FakeClient)
    recorded = []
    registry = ToolRegistry(
        policy=ActionPolicy.auto(),
        artifact_recorder=lambda path, kind: recorded.append((str(path), kind)),
    )
    server = McpServerConfig(
        name="build123d-mcp",
        source=Path(".mcp.json"),
        command="uv",
        args=("tool", "run", "--python", "3.12", "build123d-mcp@latest"),
        capabilities=("build123d",),
    )

    captured_instructions = []
    names = register_mcp_tools(
        registry,
        server=server,
        instruction_sink=lambda name, text: captured_instructions.append((name, text)),
    )
    tool = next(spec for spec in registry.specs() if spec.name == "build123d_execute")
    result = registry.execute_result("build123d_execute", {})

    export = next(spec for spec in registry.specs() if spec.name == "export")
    export_result = registry.execute_result(
        "export",
        {"filename": "model.step", "format": "step"},
    )
    resource_result = registry.execute_result(
        "read_mcp_resource",
        {"uri": "build123d://quickref"},
    )

    assert names == ["read_mcp_resource", "build123d_execute", "export"]
    assert captured_instructions == [
        ("build123d-mcp", "Use persistent build123d session; render before export.")
    ]
    assert tool.sandbox_profile == "test"
    assert result.ok and result.output == "build123d_execute ok"
    assert export.sandbox_profile == "test"
    assert export_result.ok and export_result.artifact_path == Path.cwd() / "model.step"
    assert resource_result.ok and "quickref" in resource_result.output
    assert recorded == [(str(Path.cwd() / "model.step"), "step")]


def test_chamfer_modules_do_not_import_legacy_cad_agent() -> None:
    root = Path(__file__).resolve().parents[1] / "src"
    forbidden = ("cad_agent",)
    for path in root.rglob("*.py"):
        tree = ast.parse(path.read_text(), filename=str(path))
        imports = []
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imports.extend(alias.name for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module:
                imports.append(node.module)
        assert not any(
            module == bad or module.startswith(bad + ".")
            for module in imports
            for bad in forbidden
        ), f"{path} imports forbidden capability module: {imports}"
