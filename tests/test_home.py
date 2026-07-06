"""~/.chamfer provisioning: first-run seeding, skill layering, MCP merge."""

import json

from home import (
    bundled_skills_dir,
    default_skill_dirs,
    ensure_home_seeded,
    global_mcp_config,
    global_skills_dir,
    project_skills_dir,
)


def _seed_into(monkeypatch, home) -> None:
    monkeypatch.setenv("CHAMFER_HOME", str(home))
    monkeypatch.delenv("CHAMFER_NO_SEED", raising=False)
    ensure_home_seeded()


def test_bundled_skills_dir_found_from_source_checkout() -> None:
    src = bundled_skills_dir()
    assert src is not None
    assert (src / "build123d" / "SKILL.md").is_file()


def test_first_run_seeds_skills_and_mcp_config(tmp_path, monkeypatch) -> None:
    home = tmp_path / "home"
    _seed_into(monkeypatch, home)

    assert (home / "skills" / "build123d" / "SKILL.md").is_file()
    mcp = json.loads((home / "mcp.json").read_text())
    assert "build123d-mcp" in mcp["mcpServers"]


def test_seeding_does_not_clobber_existing_home(tmp_path, monkeypatch) -> None:
    home = tmp_path / "home"
    (home / "skills").mkdir(parents=True)
    (home / "skills" / "keep.txt").write_text("mine")
    (home / "mcp.json").write_text('{"mcpServers": {}}')

    _seed_into(monkeypatch, home)

    # existing files are preserved, nothing re-seeded over them
    assert (home / "skills" / "keep.txt").read_text() == "mine"
    assert json.loads((home / "mcp.json").read_text()) == {"mcpServers": {}}
    assert not (home / "skills" / "build123d").exists()


def test_seeding_is_disabled_by_env_flag(tmp_path, monkeypatch) -> None:
    home = tmp_path / "home"
    monkeypatch.setenv("CHAMFER_HOME", str(home))
    monkeypatch.setenv("CHAMFER_NO_SEED", "1")

    ensure_home_seeded()

    assert not home.exists()


def test_default_skill_dirs_put_project_before_global(tmp_path, monkeypatch) -> None:
    home = tmp_path / "home"
    monkeypatch.setenv("CHAMFER_HOME", str(home))
    cwd = tmp_path / "proj"

    dirs = default_skill_dirs(cwd)

    assert dirs == (project_skills_dir(cwd), global_skills_dir())
    assert dirs[0] == cwd / ".chamfer" / "skills"
    assert dirs[1] == home / "skills"


def test_global_mcp_config_path_follows_home(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("CHAMFER_HOME", str(tmp_path / "h"))
    assert global_mcp_config() == tmp_path / "h" / "mcp.json"
