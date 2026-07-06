"""Harness tool definitions, registry, guardrails, and local tools."""

from __future__ import annotations

from dataclasses import dataclass, replace
from pathlib import Path
from typing import Callable

from policy import ALLOW, SKIP, ActionPolicy
from sandbox import (
    SandboxProfile,
    SandboxRunner,
    default_profiles,
    permissive_profiles,
    truncate_head,
)
from evidence import EvidenceLedger, classify_command, summarize_output

MAX_LINES = 2000
MAX_BYTES = 50 * 1024

_PATH = {"type": "string", "description": "file path (absolute or relative to cwd)"}


@dataclass(frozen=True)
class ToolResult:
    ok: bool
    output: str
    artifact_path: Path | None = None
    sandbox_profile: str | None = None
    execution_context: dict | None = None

    @classmethod
    def success(cls, output: str, artifact_path: Path | None = None) -> "ToolResult":
        return cls(ok=True, output=output, artifact_path=artifact_path)

    @classmethod
    def error(cls, output: str, artifact_path: Path | None = None) -> "ToolResult":
        prefix = output if output.startswith("error:") else f"error: {output}"
        return cls(ok=False, output=prefix, artifact_path=artifact_path)


@dataclass(frozen=True)
class ToolExecutionContext:
    profile: SandboxProfile
    runner: SandboxRunner
    artifacts_dir: Path | None = None
    evidence: EvidenceLedger | None = None
    artifact_recorder: Callable[[Path, str], None] | None = None


ToolHandler = Callable[[dict, ToolExecutionContext], ToolResult]


@dataclass(frozen=True)
class ToolDefinition:
    name: str
    description: str
    input_schema: dict
    execute: ToolHandler
    risk: str = "safe"
    sandbox_profile: str | None = None


class ToolRegistry:
    def __init__(
        self,
        *,
        policy: ActionPolicy | None = None,
        profiles: dict[str, SandboxProfile] | None = None,
        runner: SandboxRunner | None = None,
        artifacts_dir: str | Path | None = None,
        evidence: EvidenceLedger | None = None,
        artifact_recorder: Callable[[Path, str], None] | None = None,
    ) -> None:
        self._tools: dict[str, ToolDefinition] = {}
        self._policy = policy or ActionPolicy.auto()
        self._profiles = dict(profiles or default_profiles(Path.cwd()))
        self._runner = runner or SandboxRunner()
        self._artifacts_dir = Path(artifacts_dir) if artifacts_dir is not None else None
        self._evidence = evidence
        self._artifact_recorder = artifact_recorder

    def register(self, tool: ToolDefinition) -> None:
        self._tools[tool.name] = tool

    def specs(self) -> list[ToolDefinition]:
        return list(self._tools.values())

    def set_artifact_recorder(self, recorder: Callable[[Path, str], None] | None) -> None:
        self._artifact_recorder = recorder

    def profile(self, name: str) -> SandboxProfile:
        try:
            return self._profiles[name]
        except KeyError as e:
            known = ", ".join(sorted(self._profiles))
            raise KeyError(f"unknown sandbox profile {name!r}; known: {known}") from e

    def execute_result(self, name: str, params: dict) -> ToolResult:
        if name not in self._tools:
            known = ", ".join(sorted(self._tools))
            return ToolResult.error(f"unknown tool '{name}'; known tools: {known}")
        tool = self._tools[name]
        issues = validate_params(tool.input_schema, params)
        if issues:
            return ToolResult.error(
                f"invalid params for '{name}': " + "; ".join(issues)
            )
        decision = self._policy.decide(tool.risk, name, params)
        if decision == SKIP:
            return ToolResult.success(f"'{name}' skipped (dry-run policy)")
        if decision != ALLOW:
            suffix = (
                " (critical actions need a live human approver)"
                if tool.risk == "critical"
                else ""
            )
            return ToolResult.error(
                f"'{name}' is a {tool.risk} action and was denied "
                f"by the current policy{suffix}"
            )
        profile_name = tool.sandbox_profile or "read_only"
        try:
            profile = self.profile(profile_name)
        except KeyError as e:
            return ToolResult.error(str(e))
        context = ToolExecutionContext(
            profile=profile,
            runner=self._runner,
            artifacts_dir=self._artifacts_dir,
            evidence=self._evidence,
            artifact_recorder=self._artifact_recorder,
        )
        try:
            result = tool.execute(params, context)
        except Exception as e:
            return ToolResult.error(f"{name} failed: {e}")
        return replace(
            result,
            sandbox_profile=result.sandbox_profile or profile.name,
            execution_context=result.execution_context or profile.summary(),
        )

    def execute(self, name: str, params: dict) -> str:
        return self.execute_result(name, params).output


def validate_params(schema: dict, params: dict) -> list[str]:
    """Validate params against the small JSON-schema subset used by tools."""

    issues: list[str] = []
    props: dict = schema.get("properties", {})
    for key in schema.get("required", []):
        if key not in params:
            issues.append(f"param '{key}' is required")
    for key, value in params.items():
        if key not in props:
            issues.append(f"param '{key}' is not accepted by this action")
            continue
        issues.extend(_check_value(key, value, props[key]))
    return issues


def read_tool() -> ToolDefinition:
    return ToolDefinition(
        name="read",
        description="Read a text file with line numbers; page with offset/limit.",
        input_schema={
            "type": "object",
            "required": ["path"],
            "properties": {
                "path": _PATH,
                "offset": {"type": "number", "minimum": 1},
                "limit": {"type": "number", "minimum": 1},
            },
        },
        execute=_read,
        risk="safe",
        sandbox_profile="read_only",
    )


def write_tool() -> ToolDefinition:
    return ToolDefinition(
        name="write",
        description="Write a file inside the workspace. Creates parent directories.",
        input_schema={
            "type": "object",
            "required": ["path", "content"],
            "properties": {"path": _PATH, "content": {"type": "string"}},
        },
        execute=_write,
        risk="consequential",
        sandbox_profile="workspace_write",
    )


def edit_tool() -> ToolDefinition:
    return ToolDefinition(
        name="edit",
        description="Replace an exact, unique 'old' string in a file with 'new'.",
        input_schema={
            "type": "object",
            "required": ["path", "old", "new"],
            "properties": {
                "path": _PATH,
                "old": {"type": "string"},
                "new": {"type": "string"},
            },
        },
        execute=_edit,
        risk="consequential",
        sandbox_profile="workspace_write",
    )


def bash_tool() -> ToolDefinition:
    return ToolDefinition(
        name="bash",
        description="Run a shell command in the sandbox cwd.",
        input_schema={
            "type": "object",
            "required": ["command"],
            "properties": {
                "command": {"type": "string"},
                "timeout_s": {"type": "number", "exclusiveMinimum": 0},
            },
        },
        execute=_bash,
        risk="consequential",
        sandbox_profile="test",
    )


def build_local_tool_registry(
    policy: ActionPolicy | None = None,
    root: str | Path | None = None,
    *,
    artifacts_dir: str | Path | None = None,
    evidence: EvidenceLedger | None = None,
    artifact_recorder: Callable[[Path, str], None] | None = None,
    sandbox: bool = True,
) -> ToolRegistry:
    root_path = Path.cwd() if root is None else Path(root)
    profiles = default_profiles(root_path) if sandbox else permissive_profiles(root_path)
    registry = ToolRegistry(
        policy=policy or ActionPolicy.auto(),
        profiles=profiles,
        artifacts_dir=artifacts_dir,
        evidence=evidence,
        artifact_recorder=artifact_recorder,
    )
    for tool in (read_tool(), write_tool(), edit_tool(), bash_tool()):
        registry.register(tool)
    return registry


def _read(params: dict, context: ToolExecutionContext) -> ToolResult:
    path = context.profile.resolve_read_path(params["path"])
    if not path.is_file():
        return ToolResult.error(f"no such file: {path}")
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    offset = int(params.get("offset", 1))
    limit = int(params.get("limit", MAX_LINES))
    window = lines[offset - 1:offset - 1 + limit]
    body, truncated = truncate_head(
        "\n".join(window),
        max_lines=MAX_LINES,
        max_bytes=MAX_BYTES,
    )
    shown = body.splitlines()
    numbered = "\n".join(f"{offset + i}\t{line}" for i, line in enumerate(shown))
    if truncated or len(window) < len(lines) - (offset - 1):
        numbered += (
            f"\n... (truncated: showing {len(shown)} of {len(lines)} lines; "
            "use offset/limit to page)"
        )
    return ToolResult.success(numbered)


def _write(params: dict, context: ToolExecutionContext) -> ToolResult:
    path = context.profile.resolve_write_path(params["path"])
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(params["content"], encoding="utf-8")
    if context.artifact_recorder is not None:
        context.artifact_recorder(path, "write")
    return ToolResult.success(f"wrote {len(params['content'].encode())} bytes to {path}")


def _edit(params: dict, context: ToolExecutionContext) -> ToolResult:
    path = context.profile.resolve_write_path(params["path"])
    if not path.is_file():
        return ToolResult.error(f"no such file: {path}")
    text = path.read_text(encoding="utf-8")
    old = params["old"]
    count = text.count(old)
    if count == 0:
        return ToolResult.error(f"old string not found in {path}")
    if count > 1:
        return ToolResult.error(
            f"old string occurs {count} times in {path}; provide a longer unique snippet"
        )
    path.write_text(text.replace(old, params["new"], 1), encoding="utf-8")
    if context.artifact_recorder is not None:
        context.artifact_recorder(path, "edit")
    return ToolResult.success(f"edited {path}")


def _bash(params: dict, context: ToolExecutionContext) -> ToolResult:
    artifact = None
    if context.artifacts_dir is not None:
        artifact = context.artifacts_dir / "bash-full-output.txt"
    result = context.runner.run_bash(
        params["command"],
        context.profile,
        timeout_s=float(params.get("timeout_s", context.profile.timeout_s)),
        full_output_path=artifact,
        max_lines=MAX_LINES,
        max_bytes=MAX_BYTES,
    )
    if context.evidence is not None:
        context.evidence.record(
            command=params["command"],
            kind=classify_command(params["command"]),
            scope=str(context.profile.cwd),
            status="pass" if result.ok else "fail",
            exit_code=result.exit_code,
            cwd=context.profile.cwd,
            output_summary=summarize_output(result.output),
            full_output_artifact=result.full_output_path,
        )
    return ToolResult(
        ok=result.ok,
        output=result.output,
        artifact_path=result.full_output_path,
    )


def _check_value(key: str, value, spec: dict) -> list[str]:
    t = spec.get("type")
    if t == "number":
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            return [f"param '{key}' must be a number, got {value!r}"]
        if "exclusiveMinimum" in spec and value <= spec["exclusiveMinimum"]:
            return [f"param '{key}' must be > {spec['exclusiveMinimum']}, got {value}"]
        if "minimum" in spec and value < spec["minimum"]:
            return [f"param '{key}' must be >= {spec['minimum']}, got {value}"]
    elif t == "string":
        if not isinstance(value, str) or not value:
            return [f"param '{key}' must be a non-empty string, got {value!r}"]
        if "enum" in spec and value not in spec["enum"]:
            return [f"param '{key}' must be one of {spec['enum']}, got {value!r}"]
    elif t == "array":
        if not isinstance(value, list):
            return [f"param '{key}' must be an array, got {value!r}"]
        n = len(value)
        if not spec.get("minItems", 0) <= n <= spec.get("maxItems", n):
            return [f"param '{key}' must have {spec.get('minItems')} items, got {n}"]
        item_spec = spec.get("items", {})
        return [
            issue
            for index, item in enumerate(value)
            for issue in _check_value(f"{key}[{index}]", item, item_spec)
        ]
    return []
