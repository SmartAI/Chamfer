"""Generic bridge: register an external MCP server's tools into the harness.

The harness itself is CAD-agnostic. Any capability (build123d, and later others)
is provided by an external MCP server declared in .mcp.json; this module
discovers that server's tools and resources and registers them into the
ToolRegistry with sensible risk/sandbox defaults. No server-specific knowledge
lives here.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from pathlib import Path

from mcp_config import McpServerConfig
from mcp_stdio import StdioMcpClient
from tools import ToolDefinition, ToolExecutionContext, ToolRegistry, ToolResult

MAX_RESOURCE_CHARS = 20_000


def register_mcp_tools(
    registry: ToolRegistry,
    *,
    server: McpServerConfig,
    instruction_sink: Callable[[str, str], None] | None = None,
) -> list[str]:
    """Discover and register every tool from a project-configured MCP server."""

    if server.url is not None:
        raise ValueError(
            "MCP servers are supported through stdio .mcp.json config, not HTTP URLs"
        )
    if server.command is None:
        return []
    transport = StdioMcpClient(
        [server.command, *server.args],
        env=server.env,
        cwd=server.cwd,
    )
    return _register_mcp_client(
        registry,
        transport,
        server_name=server.name,
        instruction_sink=instruction_sink,
    )


def _register_mcp_client(
    registry: ToolRegistry,
    client: StdioMcpClient,
    *,
    server_name: str,
    instruction_sink: Callable[[str, str], None] | None = None,
) -> list[str]:
    resources = _list_resources_safely(client)
    if instruction_sink is not None:
        instructions = client.server_instructions().strip()
        if instructions:
            instruction_sink(server_name, instructions)
    if resources:
        registry.register(_read_mcp_resource_tool(client, resources))
    listing = client.rpc("tools/list", {})
    registered: list[str] = ["read_mcp_resource"] if resources else []
    for spec in listing.get("tools", []):
        name = spec["name"]

        def execute(params: dict, context: ToolExecutionContext, _name=name) -> ToolResult:
            result = client.call_tool(_name, params)
            text = "".join(
                block.get("text", "")
                for block in result.get("content", [])
                if block.get("type") == "text"
            ).strip()
            ok = not bool(result.get("isError")) and not _looks_like_tool_error(text)
            artifact_path = (
                _record_external_artifact(_name, params, context, text)
                if ok else None
            )
            return ToolResult(
                ok=ok,
                output=text or "(no text content)",
                artifact_path=artifact_path,
            )

        risk, sandbox_profile = _risk_and_sandbox(name)
        registry.register(ToolDefinition(
            name=name,
            description=(spec.get("description") or "MCP tool")[:280],
            input_schema=spec.get("inputSchema") or {"type": "object", "properties": {}},
            execute=execute,
            risk=risk,
            sandbox_profile=sandbox_profile,
        ))
        registered.append(name)
    return registered


def _risk_and_sandbox(name: str) -> tuple[str, str]:
    """Name-based default risk/sandbox mapping (no server-specific knowledge)."""
    if "read" in name or "inspect" in name:
        return "safe", "read_only"
    if "execute" in name or "show" in name or "export" in name:
        return "consequential", "test"
    return "consequential", "workspace_write"


def _list_resources_safely(client: StdioMcpClient) -> list[dict]:
    try:
        result = client.list_resources()
    except Exception:
        return []
    if isinstance(result, dict):
        result = result.get("resources", [])
    if not isinstance(result, list):
        return []
    return [item for item in result if isinstance(item, dict)]


def _read_mcp_resource_tool(
    client: StdioMcpClient,
    resources: list[dict],
) -> ToolDefinition:
    allowed = {
        str(resource.get("uri"))
        for resource in resources
        if isinstance(resource.get("uri"), str)
    }
    description = "Read a text MCP resource exposed by the server. Available URIs: "
    description += ", ".join(sorted(allowed))[:500]

    def execute(params: dict, context: ToolExecutionContext) -> ToolResult:
        uri = params["uri"]
        if uri not in allowed:
            return ToolResult.error(
                f"unknown MCP resource URI {uri!r}; known: {', '.join(sorted(allowed))}"
            )
        result = client.read_resource(uri)
        text = _resource_text(result)
        if len(text) > MAX_RESOURCE_CHARS:
            text = text[:MAX_RESOURCE_CHARS] + "\n... (truncated MCP resource)"
        return ToolResult.success(text or "(empty MCP resource)")

    return ToolDefinition(
        name="read_mcp_resource",
        description=description,
        input_schema={
            "type": "object",
            "required": ["uri"],
            "properties": {
                "uri": {
                    "type": "string",
                    "enum": sorted(allowed),
                }
            },
        },
        execute=execute,
        risk="safe",
        sandbox_profile="read_only",
    )


def _resource_text(result: dict) -> str:
    parts: list[str] = []
    for content in result.get("contents", []):
        if not isinstance(content, dict):
            continue
        uri = content.get("uri", "")
        mime = content.get("mimeType", "")
        text = content.get("text")
        if isinstance(text, str):
            header = f"resource: {uri}\nmimeType: {mime}\n" if uri or mime else ""
            parts.append(header + text)
        elif "blob" in content:
            parts.append(f"resource: {uri}\nmimeType: {mime}\n(binary/blob resource omitted)")
    return "\n\n".join(parts)


def _looks_like_tool_error(text: str) -> bool:
    lowered = text.lstrip().lower()
    return lowered.startswith("error:") or lowered.startswith("traceback")


def _record_external_artifact(
    tool_name: str,
    params: dict,
    context: ToolExecutionContext,
    output: str,
) -> Path | None:
    if context.artifact_recorder is None:
        return None
    if tool_name != "export":
        return None
    filename = _exported_path_from_output(output) or params.get("filename")
    if not isinstance(filename, str) or not filename:
        return None
    path = Path(filename)
    if not path.is_absolute():
        path = context.profile.cwd / path
    suffix = path.suffix.lower().lstrip(".")
    kind = suffix or str(params.get("format") or "cad")
    context.artifact_recorder(path, kind)
    return path


def _exported_path_from_output(output: str) -> str | None:
    match = re.search(r"Exported to\s+(\S+)", output)
    return match.group(1) if match else None
