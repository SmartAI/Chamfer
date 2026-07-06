"""Chamfer home (``~/.chamfer``): global skills + MCP config, seeded on first run.

Layering, highest precedence first:
  1. project    - <cwd>/.chamfer/skills, <cwd>/.mcp.json (or <cwd>/.chamfer/mcp.*)
  2. user global- ~/.chamfer/skills, ~/.chamfer/mcp.json   (seeded from bundled defaults)

The bundled defaults ship with the package; on first run they are copied into
~/.chamfer so users can edit or extend them, the same way an installed CLI
provisions its own config directory.
"""

from __future__ import annotations

import json
import os
import shutil
from pathlib import Path

# Default MCP server made available out of the box. Written to ~/.chamfer/mcp.json
# on first run; a project .mcp.json can override or add to it.
DEFAULT_MCP_CONFIG = {
    "mcpServers": {
        "build123d-mcp": {
            "command": "uv",
            "args": ["tool", "run", "--python", "3.12", "build123d-mcp@latest"],
            "capabilities": ["build123d"],
        }
    }
}


def chamfer_home() -> Path:
    """Root of Chamfer's user config/runtime dir (default ``~/.chamfer``)."""
    return Path(os.environ.get("CHAMFER_HOME") or (Path.home() / ".chamfer")).expanduser()


def bundled_skills_dir() -> Path | None:
    """Locate the default skills shipped with Chamfer (source checkout or wheel)."""
    here = Path(__file__).resolve().parent
    for candidate in (here.parent / "skills", here / "chamfer_skills"):
        if candidate.is_dir():
            return candidate
    return None


def global_skills_dir() -> Path:
    return chamfer_home() / "skills"


def global_mcp_config() -> Path:
    return chamfer_home() / "mcp.json"


def ensure_home_seeded() -> None:
    """Populate ~/.chamfer with default skills + MCP config on first run.

    No-op when the targets already exist (so user edits are never clobbered) or
    when CHAMFER_NO_SEED is set (used by the test suite to stay pristine).
    """
    if os.environ.get("CHAMFER_NO_SEED"):
        return
    home = chamfer_home()
    skills = global_skills_dir()
    if not skills.exists():
        source = bundled_skills_dir()
        if source is not None:
            shutil.copytree(source, skills)
    mcp = global_mcp_config()
    if not mcp.exists():
        home.mkdir(parents=True, exist_ok=True)
        mcp.write_text(json.dumps(DEFAULT_MCP_CONFIG, indent=2) + "\n", encoding="utf-8")


def project_skills_dir(cwd: str | Path) -> Path:
    return Path(cwd).resolve() / ".chamfer" / "skills"


def default_skill_dirs(cwd: str | Path) -> tuple[Path, ...]:
    """Skill search roots, highest precedence first (project, then user global).

    The loader keeps the first skill seen for a given name, so a project skill
    overrides a same-named global one.
    """
    return (project_skills_dir(cwd), global_skills_dir())
