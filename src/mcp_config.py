"""Project-local MCP server configuration discovery."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

CONFIG_NAMES = (
    ".mcp.json",
    ".mcp.yaml",
    ".mcp.yml",
    "mcp.json",
    "mcp.yaml",
    "mcp.yml",
    ".chamfer/mcp.json",
    ".chamfer/mcp.yaml",
    ".chamfer/mcp.yml",
)


@dataclass(frozen=True)
class McpServerConfig:
    name: str
    source: Path
    url: str | None = None
    command: str | None = None
    args: tuple[str, ...] = ()
    env: dict[str, str] = field(default_factory=dict)
    cwd: Path | None = None
    capabilities: tuple[str, ...] = ()

    @property
    def is_http(self) -> bool:
        return self.url is not None

    @property
    def is_stdio(self) -> bool:
        return self.command is not None


def discover_project_mcp_configs(
    cwd: str | Path,
    *,
    explicit: str | Path | None = None,
) -> list[McpServerConfig]:
    """Find and parse MCP config under the project directory or its parents."""

    if explicit is not None:
        path = Path(explicit).expanduser().resolve()
        return load_mcp_config(path)
    root = _find_config_root(Path(cwd).resolve())
    if root is None:
        return []
    for name in CONFIG_NAMES:
        path = root / name
        if path.is_file():
            return load_mcp_config(path)
    return []


def load_mcp_config(path: str | Path) -> list[McpServerConfig]:
    config_path = Path(path).resolve()
    data = _load_mapping(config_path)
    servers = data.get("mcpServers", data.get("servers", data))
    if not isinstance(servers, dict):
        raise ValueError(f"MCP config {config_path} must contain a mapping of servers")
    parsed: list[McpServerConfig] = []
    for name, raw in servers.items():
        if not isinstance(raw, dict):
            continue
        server = _server_from_mapping(str(name), raw, source=config_path)
        if server is not None:
            parsed.append(server)
    return parsed


def _find_config_root(cwd: Path) -> Path | None:
    directory = cwd
    while True:
        if any((directory / name).is_file() for name in CONFIG_NAMES):
            return directory
        if directory.parent == directory:
            return None
        directory = directory.parent


def _load_mapping(path: Path) -> dict[str, Any]:
    text = path.read_text(encoding="utf-8")
    if path.suffix.lower() == ".json":
        data = json.loads(text)
    else:
        data = yaml.safe_load(text)
    if not isinstance(data, dict):
        raise ValueError(f"MCP config {path} must be a mapping")
    return data


def _server_from_mapping(
    name: str,
    raw: dict[str, Any],
    *,
    source: Path,
) -> McpServerConfig | None:
    url = raw.get("url")
    command = raw.get("command")
    if not isinstance(url, str):
        url = None
    if not isinstance(command, str):
        command = None
    if url is None and command is None:
        return None

    args = raw.get("args", ())
    if not isinstance(args, list):
        args = ()
    env = raw.get("env", {})
    if not isinstance(env, dict):
        env = {}
    capabilities = raw.get("capabilities", ())
    if isinstance(capabilities, str):
        capabilities = [capabilities]
    if not isinstance(capabilities, list):
        capabilities = []
    cwd_value = raw.get("cwd")
    server_cwd = None
    if isinstance(cwd_value, str) and cwd_value:
        raw_cwd = Path(cwd_value).expanduser()
        server_cwd = raw_cwd if raw_cwd.is_absolute() else source.parent / raw_cwd
    return McpServerConfig(
        name=name,
        source=source,
        url=url,
        command=command,
        args=tuple(str(arg) for arg in args),
        env={str(key): str(value) for key, value in env.items()},
        cwd=server_cwd,
        capabilities=tuple(str(item) for item in capabilities),
    )
