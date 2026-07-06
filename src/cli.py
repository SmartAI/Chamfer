"""Harness-first CLI entry point."""

from __future__ import annotations

import argparse
import os
import shutil
import sys
from pathlib import Path
from typing import ClassVar

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
from workflow import StageResult, WorkflowContext, text_to_cad_workflow


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
    run.add_argument("--max-turns", type=int, default=50)
    run.add_argument(
        "--verbose",
        nargs="?",
        const=True,
        default=True,
        type=_parse_bool,
        metavar="{true,false}",
        help=(
            "print user-facing progress and summary (default: true); "
            "pass --verbose false or --verbose 0 for quiet stdout"
        ),
    )
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
        _print_error(args, e)
        return 2

    out_root = Path(args.out).expanduser() if args.out else default_runtime_root()
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
        _print_error(args, f"MCP configuration failed: {e}")
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
    if args.verbose:
        _print_mcp_status(mcp_servers)
    reporter = CliRunReporter() if args.verbose else None
    agent_session = AgentSession.create(
        out_root=out_root,
        task=args.task,
        llm=llm,
        tools=tools,
        system_prompt=system_prompt,
        mode="workflow",
        max_turns=args.max_turns,
    )
    results = text_to_cad_workflow(tools).run(WorkflowContext(
        task=args.task,
        agent_session=agent_session,
        tools=tools,
        reporter=reporter,
    ))
    ok = all(result.ok for result in results)
    delivered: list[Path] | None = None
    delivered_outputs: list[Path] | None = None
    if ok and args.output:
        try:
            delivered = _deliver_output(agent_session.workspace, args.output)
        except LLMError as e:
            _print_error(args, e)
            return 1
    elif ok:
        try:
            delivered_outputs = _deliver_default_outputs(agent_session.workspace, Path.cwd())
        except LLMError as e:
            _print_error(args, e)
            return 1
    if args.verbose:
        _print_run_summary(
            ok=ok,
            results=results,
            workspace=agent_session.workspace,
            delivered=delivered,
            delivered_outputs=delivered_outputs,
        )
    return 0 if ok else 1


def _parse_bool(value: str | bool) -> bool:
    if isinstance(value, bool):
        return value
    lowered = value.strip().lower()
    if lowered in {"1", "true", "t", "yes", "y", "on"}:
        return True
    if lowered in {"0", "false", "f", "no", "n", "off"}:
        return False
    raise argparse.ArgumentTypeError("expected true/false or 1/0")


def _print_error(args, error: object) -> None:
    if args.verbose:
        print(f"error: {error}", file=sys.stderr)


class CliRunReporter:
    _labels: ClassVar[dict[str, str]] = {
        "requirements": "Capturing requirements",
        "plan": "Planning workflow",
        "develop": "Building CAD",
        "verify": "Verifying output",
        "output": "Preparing summary",
    }

    def stage_start(self, name: str) -> None:
        print(f"{self._label(name)}...", flush=True)

    def stage_end(self, result: StageResult) -> None:
        status = "OK" if result.ok else "FAILED"
        print(f"{self._label(result.name)}: {status}", flush=True)

    def _label(self, name: str) -> str:
        return self._labels.get(name, name.replace("_", " ").title())


def _print_mcp_status(servers: list[McpServerConfig]) -> None:
    if not servers:
        return
    names = ", ".join(server.name for server in servers)
    print(f"Using MCP: {names}", flush=True)


def _print_run_summary(
    *,
    ok: bool,
    results: list[StageResult],
    workspace,
    delivered: list[Path] | None,
    delivered_outputs: list[Path] | None,
) -> None:
    if ok:
        print("DONE")
        if delivered is not None:
            output_paths = delivered
        elif delivered_outputs is not None:
            output_paths = delivered_outputs
        else:
            output_paths = _generated_output_paths(workspace)
        summary = _success_summary(results, workspace, output_paths)
        if summary:
            print("Summary:")
            print(summary)
        if output_paths:
            print("Output:")
            for path in output_paths:
                print(f"  {path}")
        else:
            print("Output: no CAD file was produced")
        verification = _verification_status(results)
        if verification:
            print(f"Verification: {verification}")
    else:
        failure = next((result for result in results if not result.ok), None)
        reason = _user_failure_detail(failure.detail if failure else "")
        print(f"FAILED: {reason}")


def _generated_output_paths(workspace) -> list[Path]:
    paths: list[Path] = []
    for entry in workspace.manifest().get("generated_files", []):
        if not isinstance(entry, dict) or not entry.get("path"):
            continue
        paths.append(_manifest_path(workspace, str(entry["path"])))
    return paths


def _success_summary(
    results: list[StageResult],
    workspace,
    output_paths: list[Path],
) -> str:
    for result in results:
        if result.name == "develop" and result.ok:
            return _rewrite_summary_paths(
                _user_summary(result.detail),
                workspace,
                output_paths,
            )
    return ""


def _verification_status(results: list[StageResult]) -> str | None:
    for result in results:
        if result.name == "verify":
            if "skipped" in result.detail.lower():
                return result.detail
            return "PASS" if result.ok else "FAILED"
    return None


def _user_summary(detail: str) -> str:
    text = detail.strip()
    if not text or "```tool_call" in text:
        return ""
    return text


def _user_failure_detail(detail: str) -> str:
    text = " ".join(detail.strip().split())
    if not text:
        return "The workflow stopped before producing a completed CAD output."
    lowered = text.lower()
    if "max turns" in lowered:
        return (
            "Agent reached max turns before completing the CAD workflow. "
            "Try increasing --max-turns or simplifying the request."
        )
    if "```tool_call" in text:
        return "The agent produced an invalid internal tool request before completing the CAD workflow."
    if len(text) > 300:
        return text[:297].rstrip() + "..."
    return text


def _rewrite_summary_paths(summary: str, workspace, output_paths: list[Path]) -> str:
    if not summary or not output_paths:
        return summary
    generated = _generated_output_paths(workspace)
    if not generated:
        return summary
    replacements: dict[str, str] = {}
    if len(generated) == len(output_paths):
        replacements = {
            str(src): str(dest)
            for src, dest in zip(generated, output_paths, strict=True)
            if src != dest
        }
    elif len(output_paths) == 1:
        replacements = {
            str(src): str(output_paths[0])
            for src in generated
            if src != output_paths[0]
        }
    for src, dest in sorted(replacements.items(), key=lambda item: len(item[0]), reverse=True):
        summary = summary.replace(src, dest)
    return summary


def _deliver_output(workspace, output: str) -> list[Path]:
    """Copy generated CAD artifact(s) to a user-chosen file or directory."""
    manifest = workspace.manifest()
    generated = [
        entry for entry in manifest.get("generated_files", [])
        if isinstance(entry, dict) and entry.get("path")
    ]
    if not generated:
        raise LLMError("no generated CAD file to copy to the requested output path")
    dest = Path(output).expanduser()
    if _output_is_directory(output, dest):
        delivered = _deliver_entries_to_directory(workspace, generated, dest)
        if not delivered:
            raise LLMError("generated CAD files were recorded but missing on disk")
        return delivered
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
    return [dest]


def _output_is_directory(raw_output: str, dest: Path) -> bool:
    return (
        raw_output.endswith((os.sep, "/"))
        or (os.altsep is not None and raw_output.endswith(os.altsep))
        or dest.is_dir()
        or dest.suffix == ""
    )


def _deliver_entries_to_directory(workspace, entries: list[dict], output_dir: Path) -> list[Path]:
    delivered: list[Path] = []
    output_dir.mkdir(parents=True, exist_ok=True)
    for entry in entries:
        src = _manifest_path(workspace, str(entry["path"]))
        if not src.is_file():
            continue
        dest = _unique_destination(output_dir / src.name, src.resolve())
        shutil.copyfile(src, dest)
        delivered.append(dest)
    return delivered


def _deliver_default_outputs(workspace, cwd: Path) -> list[Path]:
    """Expose generated files in the invocation directory by default.

    The run workspace remains an internal log/artifact area. When a CAD backend
    records a file under that workspace, copy it into the directory where the
    user invoked Chamfer so normal output points at user-visible deliverables.
    """
    delivered: list[Path] = []
    cwd = cwd.resolve()
    for entry in workspace.manifest().get("generated_files", []):
        if not isinstance(entry, dict) or not entry.get("path"):
            continue
        src = _manifest_path(workspace, str(entry["path"]))
        if not src.is_file():
            continue
        src = src.resolve()
        if _is_relative_to(src, workspace.dir.resolve()):
            dest = _unique_destination(cwd / src.name, src)
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(src, dest)
            delivered.append(dest)
            continue
        if _is_relative_to(src, cwd):
            delivered.append(src.resolve())
            continue
        dest = _unique_destination(cwd / src.name, src)
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dest)
        delivered.append(dest)
    return delivered


def _manifest_path(workspace, path: str) -> Path:
    p = Path(path).expanduser()
    if not p.is_absolute():
        p = workspace.dir / p
    return p.resolve()


def _unique_destination(dest: Path, src: Path) -> Path:
    dest = dest.resolve()
    if dest.exists() and dest.samefile(src):
        return dest
    if not dest.exists():
        return dest
    stem = dest.stem
    suffix = dest.suffix
    for index in range(1, 1000):
        candidate = dest.with_name(f"{stem}-{index}{suffix}")
        if not candidate.exists():
            return candidate
    raise LLMError(f"could not choose a free output path for {src.name}")


def _is_relative_to(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


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
