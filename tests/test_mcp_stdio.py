import sys
from pathlib import Path

import pytest

from mcp_stdio import McpClientError, StdioMcpClient

FAKE_SERVER = [sys.executable, str(Path(__file__).parents[0] / "fake_stdio_mcp.py")]


@pytest.fixture()
def client():
    c = StdioMcpClient(FAKE_SERVER)
    yield c
    c.close()


def test_stdio_mcp_handshake_and_tool_call(client) -> None:
    listing = client.rpc("tools/list", {})
    assert listing["tools"][0]["name"] == "make_box"

    result = client.call_tool("make_box", {"size": 5})

    assert result["content"][0]["text"] == "ok"
    assert "read quickref" in client.server_instructions()


def test_stdio_mcp_lists_and_reads_resources(client) -> None:
    resources = client.list_resources()
    templates = client.list_resource_templates()
    content = client.read_resource("build123d://quickref")

    assert resources[0]["uri"] == "build123d://quickref"
    assert templates[0]["uriTemplate"] == "build123d://docs/{topic}"
    assert content["contents"][0]["text"] == "quick reference text"


def test_stdio_mcp_jsonrpc_error_raises(client) -> None:
    with pytest.raises(McpClientError, match="stdio boom"):
        client.call_tool("fail", {})


def test_stdio_mcp_unlaunchable_command_fails_clearly() -> None:
    c = StdioMcpClient(["/nonexistent-binary-xyz"])
    with pytest.raises(McpClientError, match="cannot launch MCP server"):
        c.rpc("tools/list", {})


def test_stdio_mcp_init_failure_cleans_up() -> None:
    c = StdioMcpClient([*FAKE_SERVER, "--fail-init"])
    with pytest.raises(McpClientError, match="MCP initialize failed"):
        c.rpc("tools/list", {})
    assert c._proc is None
