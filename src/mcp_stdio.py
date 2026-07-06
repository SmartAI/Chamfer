"""Minimal MCP stdio client for project-configured tool servers."""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Any

_PROTOCOL = "2025-03-26"


class McpClientError(RuntimeError):
    """MCP client failure: server launch, handshake, or JSON-RPC error."""


class StdioMcpClient:
    """JSON-RPC MCP client over a launched process' stdin/stdout."""

    def __init__(
        self,
        argv: list[str],
        *,
        env: dict[str, str] | None = None,
        cwd: str | Path | None = None,
        client_name: str = "chamfer",
    ) -> None:
        self._argv = list(argv)
        self._env = dict(env or {})
        self._cwd = Path(cwd) if cwd is not None else None
        self._client_name = client_name
        self._proc: subprocess.Popen | None = None
        self._initialized = False
        self._initialize_result: dict[str, Any] | None = None
        self._next_id = 0

    def initialize_result(self) -> dict[str, Any]:
        self._ensure_initialized()
        return dict(self._initialize_result or {})

    def server_instructions(self) -> str:
        instructions = self.initialize_result().get("instructions")
        return instructions if isinstance(instructions, str) else ""

    def rpc(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        self._ensure_initialized()
        self._next_id += 1
        reply = self._send({
            "jsonrpc": "2.0",
            "id": self._next_id,
            "method": method,
            "params": params,
        })
        if reply is None or "error" in reply:
            raise McpClientError(f"MCP call {method} failed: {reply and reply.get('error')}")
        return reply["result"]

    def call_tool(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        return self.rpc("tools/call", {"name": name, "arguments": arguments})

    def list_resources(self) -> list[dict[str, Any]]:
        return list(self.rpc("resources/list", {}).get("resources", []))

    def list_resource_templates(self) -> list[dict[str, Any]]:
        return list(
            self.rpc("resources/templates/list", {}).get("resourceTemplates", [])
        )

    def read_resource(self, uri: str) -> dict[str, Any]:
        return self.rpc("resources/read", {"uri": uri})

    def close(self) -> None:
        if self._proc is None:
            return
        self._proc.terminate()
        try:
            self._proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            self._proc.kill()
            self._proc.wait()
        self._proc = None

    def _ensure_started(self) -> None:
        if self._proc is not None:
            return
        try:
            self._proc = subprocess.Popen(
                self._argv,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                env={**os.environ, **self._env} if self._env else None,
                cwd=str(self._cwd) if self._cwd is not None else None,
            )
        except OSError as e:
            raise McpClientError(
                f"cannot launch MCP server {' '.join(self._argv)!r}: {e}"
            ) from e

    def _ensure_initialized(self) -> None:
        if self._initialized:
            return
        self._ensure_started()
        try:
            reply = self._send({
                "jsonrpc": "2.0",
                "id": 0,
                "method": "initialize",
                "params": {
                    "protocolVersion": _PROTOCOL,
                    "capabilities": {},
                    "clientInfo": {"name": self._client_name, "version": "0.1.0"},
                },
            })
            if reply is None or "error" in reply:
                raise McpClientError(f"MCP initialize failed: {reply}")
            self._initialize_result = reply.get("result", {})
            self._initialized = True
            self._send({"jsonrpc": "2.0", "method": "notifications/initialized"})
        except BaseException:
            self.close()
            raise

    def _send(self, payload: dict[str, Any]) -> dict[str, Any] | None:
        self._ensure_started()
        if not (self._proc and self._proc.stdin and self._proc.stdout):
            raise McpClientError(f"MCP server {' '.join(self._argv)!r} is not running")
        self._proc.stdin.write(json.dumps(payload) + "\n")
        self._proc.stdin.flush()
        if "id" not in payload:
            return None
        line = self._proc.stdout.readline()
        if not line:
            raise McpClientError(
                f"MCP server {' '.join(self._argv)!r} closed its stdout"
            )
        return json.loads(line)
