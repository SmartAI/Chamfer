import json

from mcp_config import discover_project_mcp_configs, load_mcp_config


def test_load_mcp_config_accepts_claude_style_stdio_server(tmp_path) -> None:
    config = tmp_path / ".mcp.json"
    config.write_text(json.dumps({
        "mcpServers": {
            "build123d": {
                "command": "uvx",
                "args": ["build123d-mcp"],
                "env": {"A": "B"},
                "cwd": "tools",
                "capabilities": ["build123d"],
            }
        }
    }))

    servers = load_mcp_config(config)

    assert len(servers) == 1
    server = servers[0]
    assert server.name == "build123d"
    assert server.command == "uvx"
    assert server.args == ("build123d-mcp",)
    assert server.env == {"A": "B"}
    assert server.cwd == tmp_path / "tools"
    assert server.capabilities == ("build123d",)
    assert server.is_stdio


def test_discover_project_mcp_configs_walks_up_to_project_root(tmp_path) -> None:
    config = tmp_path / ".chamfer" / "mcp.yaml"
    config.parent.mkdir()
    config.write_text(
        "mcpServers:\n"
        "  build123d:\n"
        "    url: http://127.0.0.1:3001/mcp\n"
        "    capabilities: build123d\n"
    )
    subdir = tmp_path / "src" / "nested"
    subdir.mkdir(parents=True)

    servers = discover_project_mcp_configs(subdir)

    assert len(servers) == 1
    assert servers[0].url == "http://127.0.0.1:3001/mcp"
    assert servers[0].capabilities == ("build123d",)
    assert servers[0].source == config.resolve()


def test_discover_project_mcp_configs_explicit_file_takes_precedence(tmp_path) -> None:
    root_config = tmp_path / ".mcp.json"
    explicit_config = tmp_path / "custom.json"
    root_config.write_text(json.dumps({
        "mcpServers": {"root": {"url": "http://127.0.0.1:1/mcp"}}
    }))
    explicit_config.write_text(json.dumps({
        "mcpServers": {"explicit": {"url": "http://127.0.0.1:2/mcp"}}
    }))

    servers = discover_project_mcp_configs(tmp_path, explicit=explicit_config)

    assert [server.name for server in servers] == ["explicit"]
    assert servers[0].url == "http://127.0.0.1:2/mcp"


def test_discover_merges_global_home_and_project_with_project_override(
    tmp_path, monkeypatch
) -> None:
    from cli import _discover_mcp_servers

    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("CHAMFER_HOME", str(home))
    # global default declares two servers
    (home / "mcp.json").write_text(json.dumps({
        "mcpServers": {
            "build123d-mcp": {"command": "uv", "args": ["a"], "capabilities": ["build123d"]},
            "extra": {"command": "x", "args": []},
        }
    }))
    # project overrides build123d-mcp and adds nothing else
    proj = tmp_path / "proj"
    proj.mkdir()
    (proj / ".mcp.json").write_text(json.dumps({
        "mcpServers": {
            "build123d-mcp": {"command": "OVERRIDDEN", "args": ["b"], "capabilities": ["build123d"]},
        }
    }))

    servers = {s.name: s for s in _discover_mcp_servers(proj, explicit=None)}

    assert set(servers) == {"build123d-mcp", "extra"}
    assert servers["build123d-mcp"].command == "OVERRIDDEN"  # project wins
    assert servers["extra"].command == "x"                    # global-only kept


def test_explicit_config_ignores_global_home(tmp_path, monkeypatch) -> None:
    from cli import _discover_mcp_servers

    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("CHAMFER_HOME", str(home))
    (home / "mcp.json").write_text('{"mcpServers": {"g": {"command": "x", "args": []}}}')
    explicit = tmp_path / "explicit.json"
    explicit.write_text('{"mcpServers": {"only": {"command": "y", "args": []}}}')

    names = {s.name for s in _discover_mcp_servers(tmp_path, explicit=str(explicit))}
    assert names == {"only"}
