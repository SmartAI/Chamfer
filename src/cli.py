"""Harness-first CLI entry point."""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

from agent import AgentSession
from evidence import EvidenceLedger
from home import (
    chamfer_home,
    default_skill_dirs,
    ensure_home_seeded,
    global_mcp_config,
)
from llm import (
    AnthropicLLM,
    ClaudeCliSessionLLM,
    CodexCliLLM,
    LLMError,
    OpenAILLM,
    OpenRouterLLM,
    scripted_llm_from_dir,
)
from mcp_config import (
    McpServerConfig,
    discover_project_mcp_configs,
    load_mcp_config,
)
from mcp_tools import register_mcp_tools
from policy import ActionPolicy
from prompt import build_system_prompt
from resources import ProjectInstruction, ResourceLoader, Sanitizer
from tools import build_local_tool_registry
from verify.tool import register_verify_tools
from workflow import WorkflowContext, text_to_cad_workflow


def default_runtime_root() -> Path:
    """Runtime output root, kept out of the working tree by default.

    Runs, evidence, and artifacts land under ``$CHAMFER_HOME`` (default
    ``~/.chamfer``) so a checkout of the repo stays clean, the same way
    Claude Code uses ``~/.claude`` and Codex uses ``~/.codex``.
    """
    return chamfer_home() / "runs"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="chamfer")
    sub = parser.add_subparsers(dest="cmd")
    run = sub.add_parser("run", help="run the harness text-to-CAD workflow")
    run.add_argument("task")
    run.add_argument(
        "--out",
        default=None,
        help=(
            "run root for workspaces/evidence/artifacts "
            "(default: $CHAMFER_HOME/runs, i.e. ~/.chamfer/runs)"
        ),
    )
    run.add_argument(
        "-o",
        "--output",
        default=None,
        help=(
            "final deliverable path, e.g. /path/to/output/part.step; parent "
            "directories are created if missing and the generated CAD file is "
            "copied there when the run passes"
        ),
    )
    run.add_argument(
        "--provider",
        choices=[
            "scripted",
            "openrouter",
            "openai",
            "anthropic",
            "codex-cli",
            "claude-code",
        ],
        default=None,
        help=(
            "LLM provider. openrouter/openai/anthropic read their API key from "
            "the environment (OPEN_ROUTER_API/OPENROUTER_API_KEY, OPENAI_API_KEY, "
            "ANTHROPIC_API_KEY). Defaults to scripted when --scripted-dir is set."
        ),
    )
    # Deprecated alias for --provider (codex -> codex-cli, claude-cli -> claude-code).
    run.add_argument("--llm", choices=["scripted", "codex", "claude-cli"], default=None,
                     help=argparse.SUPPRESS)
    run.add_argument("--scripted-dir")
    run.add_argument("--model", default=None, help="model id/name for the chosen provider")
    # Deprecated alias for --model.
    run.add_argument("--codex-model", default=None, help=argparse.SUPPRESS)
    run.add_argument("--llm-timeout", type=float, default=900.0)
    run.add_argument("--max-turns", type=int, default=8)
    run.add_argument("--skills-dir", action="append", default=[])
    sandbox_group = run.add_mutually_exclusive_group()
    sandbox_group.add_argument(
        "--sandbox",
        dest="sandbox",
        action="store_true",
        help="enable filesystem sandbox discipline (currently disabled by default)",
    )
    sandbox_group.add_argument(
        "--no-sandbox",
        dest="sandbox",
        action="store_false",
        help="disable the filesystem sandbox (default, temporary)",
    )
    run.set_defaults(sandbox=False)
    run.add_argument(
        "--mcp-config",
        default=None,
        help="explicit MCP config path; otherwise discover .mcp.json/.yaml or .chamfer/mcp.*",
    )
    args = parser.parse_args(argv)
    if args.cmd != "run":
        parser.print_help()
        return 2
    # Provision ~/.chamfer (default skills + MCP config) on first run.
    ensure_home_seeded()
    try:
        llm = _make_llm(args)
    except LLMError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2

    out_root = Path(args.out).expanduser() if args.out else default_runtime_root()
    if not args.sandbox:
        print("note: sandbox disabled (--no-sandbox is the current default)", file=sys.stderr)
    evidence = EvidenceLedger(out_root / "evidence.jsonl")
    tools = build_local_tool_registry(
        ActionPolicy.auto(),
        Path.cwd(),
        artifacts_dir=out_root / "artifacts",
        evidence=evidence,
        sandbox=args.sandbox,
    )
    try:
        mcp_servers = _discover_mcp_servers(Path.cwd(), explicit=args.mcp_config)
        available_capabilities, mcp_instructions = _register_configured_mcp_servers(
            tools,
            mcp_servers,
        )
        register_verify_tools(tools)
    except Exception as e:
        print(f"error: MCP configuration failed: {e}", file=sys.stderr)
        return 2
    skill_dirs = (
        *default_skill_dirs(Path.cwd()),
        *(Path(p) for p in args.skills_dir),
    )
    resources = ResourceLoader(cwd=Path.cwd(), skill_dirs=skill_dirs).load(
        available_tools={tool.name for tool in tools.specs()},
        available_capabilities=available_capabilities,
        session_id="cli",
    )
    system_prompt = build_system_prompt(
        tools=tools,
        skills=resources.skills,
        mcp_instructions=mcp_instructions,      # MCP server instructions/resources
        instructions=resources.instructions,    # user-provided CHAMFER.md
        cwd=str(Path.cwd()),
        workflow_name="text_to_cad",
    )
    agent_session = AgentSession.create(
        out_root=out_root,
        task=args.task,
        llm=llm,
        tools=tools,
        system_prompt=system_prompt,
        mode="workflow",
        max_turns=args.max_turns,
        echo=lambda text: print(text, flush=True),
    )
    results = text_to_cad_workflow(tools).run(WorkflowContext(
        task=args.task,
        agent_session=agent_session,
        tools=tools,
    ))
    ok = all(result.ok for result in results)
    if ok and args.output:
        try:
            dest = _deliver_output(agent_session.workspace, args.output)
        except LLMError as e:
            print(f"error: {e}", file=sys.stderr)
            return 1
        print(f"output: {dest}")
    print(f"{'DONE' if ok else 'FAILED'}: {agent_session.workspace.dir}")
    return 0 if ok else 1


def _deliver_output(workspace, output: str) -> Path:
    """Copy the run's final CAD artifact to a user-chosen path, creating dirs."""
    manifest = workspace.manifest()
    generated = [
        entry for entry in manifest.get("generated_files", [])
        if isinstance(entry, dict) and entry.get("path")
    ]
    if not generated:
        raise LLMError("no generated CAD file to copy to the requested output path")
    dest = Path(output).expanduser()
    suffix = dest.suffix.lower().lstrip(".")

    def _matches(entry: dict) -> bool:
        path = str(entry.get("path", ""))
        kind = str(entry.get("kind", "")).lower()
        return kind == suffix or path.lower().endswith(f".{suffix}")

    chosen = next((e for e in reversed(generated) if suffix and _matches(e)), generated[-1])
    src = Path(chosen["path"])
    if not src.is_absolute():
        src = (workspace.dir / src).resolve()
    if not src.is_file():
        raise LLMError(f"generated file recorded but missing on disk: {src}")
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(src, dest)
    return dest


def _discover_mcp_servers(
    cwd: Path,
    *,
    explicit: str | None,
) -> list[McpServerConfig]:
    """Global ~/.chamfer/mcp.json plus project config; project overrides by name."""
    by_name: dict[str, McpServerConfig] = {}
    global_mcp = global_mcp_config()
    if explicit is None and global_mcp.is_file():
        for server in load_mcp_config(global_mcp):
            by_name[server.name] = server
    for server in discover_project_mcp_configs(cwd, explicit=explicit):
        by_name[server.name] = server
    return list(by_name.values())


def _register_configured_mcp_servers(
    tools,
    servers: list[McpServerConfig],
) -> tuple[set[str], tuple[ProjectInstruction, ...]]:
    capabilities: set[str] = set()
    instructions: list[ProjectInstruction] = []
    sanitizer = Sanitizer()

    def instruction_sink(server_name: str, content: str) -> None:
        cleaned, unsafe = sanitizer.sanitize(content)
        instructions.append(ProjectInstruction(
            path=f"mcp://{server_name}/instructions",
            content=cleaned,
            unsafe=unsafe,
        ))

    for server in servers:
        names = register_mcp_tools(
            tools,
            server=server,
            instruction_sink=instruction_sink,
        )
        if names:
            # Capabilities are declared by the server config, not hardcoded here.
            capabilities.update(server.capabilities)
    return capabilities, tuple(instructions)


_LLM_ALIAS = {"codex": "codex-cli", "claude-cli": "claude-code"}


def _resolve_provider(args) -> str:
    if args.provider:
        return args.provider
    if args.llm:  # deprecated --llm alias
        return _LLM_ALIAS.get(args.llm, args.llm)
    if args.scripted_dir:
        return "scripted"
    raise LLMError(
        "no provider selected; pass --provider "
        "(scripted/openrouter/openai/anthropic/codex-cli/claude-code) "
        "or --scripted-dir"
    )


def _make_llm(args):
    provider = _resolve_provider(args)
    model = args.model or args.codex_model
    if provider == "scripted":
        if not args.scripted_dir:
            raise LLMError("--scripted-dir is required when --provider scripted")
        return scripted_llm_from_dir(args.scripted_dir)
    if provider == "openrouter":
        return OpenRouterLLM(model=model, timeout_s=args.llm_timeout)
    if provider == "openai":
        return OpenAILLM(**({"model": model} if model else {}))
    if provider == "anthropic":
        return AnthropicLLM(**({"model": model} if model else {}))
    if provider == "codex-cli":
        return CodexCliLLM(
            cwd=Path.cwd(),
            timeout_s=args.llm_timeout,
            model=model,
        )
    if provider == "claude-code":
        return ClaudeCliSessionLLM(
            model=model or "opus",
            timeout_s=args.llm_timeout,
        )
    raise LLMError(f"unsupported provider {provider!r}")


if __name__ == "__main__":
    raise SystemExit(main())
