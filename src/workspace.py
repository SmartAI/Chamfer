"""Harness run workspace and manifest recorder."""

from __future__ import annotations

import json
import os
import re
import secrets
import time
from pathlib import Path


class WorkspaceManager:
    def __init__(self, run_dir: str | Path, workspace_id: str) -> None:
        self.dir = Path(run_dir).expanduser().resolve()
        self.workspace_id = workspace_id
        self.artifacts_dir = self.dir / "artifacts"
        self.generated_dir = self.dir / "generated"
        self.renders_dir = self.dir / "renders"
        self.session_path = self.dir / "session.jsonl"
        self._manifest_path = self.dir / "manifest.json"

    @classmethod
    def create(
        cls,
        out_root: str | Path,
        task: str,
        *,
        mode: str = "agent",
        session_id: str | None = None,
    ) -> WorkspaceManager:
        workspace_id = _make_workspace_id(task)
        ws = cls(Path(out_root) / workspace_id, workspace_id)
        ws.artifacts_dir.mkdir(parents=True, exist_ok=True)
        ws.generated_dir.mkdir(parents=True, exist_ok=True)
        ws.renders_dir.mkdir(parents=True, exist_ok=True)
        ws._write_manifest({
            "workspace_id": workspace_id,
            "session_id": session_id,
            "mode": mode,
            "status": "running",
            "started": _stamp(),
            "session_log": "session.jsonl",
            "artifacts": {},
            "generated_files": [],
            "renders": [],
        })
        return ws

    @property
    def manifest_path(self) -> Path:
        return self._manifest_path

    def manifest(self) -> dict:
        try:
            return json.loads(self._manifest_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {"workspace_id": self.workspace_id}

    def link_session(self, session_id: str) -> None:
        self.update(session_id=session_id)

    def record_artifact(self, name: str, data: dict, *, filename: str | None = None) -> Path:
        safe = filename or f"{_slug(name).replace('_', '-')}.json"
        path = self.artifacts_dir / safe
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data, indent=2, default=str) + "\n", encoding="utf-8")
        manifest = self.manifest()
        manifest.setdefault("artifacts", {})[name] = _rel(self.dir, path)
        self._write_manifest(manifest)
        return path

    def record_text_artifact(self, name: str, text: str, *, filename: str | None = None) -> Path:
        safe = filename or f"{_slug(name).replace('_', '-')}.md"
        path = self.artifacts_dir / safe
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text.rstrip() + "\n", encoding="utf-8")
        manifest = self.manifest()
        manifest.setdefault("artifacts", {})[name] = _rel(self.dir, path)
        self._write_manifest(manifest)
        return path

    def record_generated_file(self, path: str | Path, *, kind: str = "file") -> Path:
        p = Path(path)
        if not p.is_absolute():
            p = self.dir / p
        p = p.resolve()
        manifest = self.manifest()
        entries = manifest.setdefault("generated_files", [])
        entry = {"path": _rel(self.dir, p), "kind": kind}
        if entry not in entries:
            entries.append(entry)
            self._write_manifest(manifest)
        return p

    def record_render(self, path: str | Path, *, label: str = "render") -> Path:
        p = Path(path)
        if not p.is_absolute():
            p = self.dir / p
        p = p.resolve()
        manifest = self.manifest()
        entries = manifest.setdefault("renders", [])
        entry = {"path": _rel(self.dir, p), "label": label}
        if entry not in entries:
            entries.append(entry)
            self._write_manifest(manifest)
        return p

    def update(self, **fields) -> None:
        manifest = self.manifest()
        manifest.update(fields)
        self._write_manifest(manifest)

    def finalize(self, status: str, **fields) -> None:
        self.update(status=status, ended=_stamp(), **fields)

    def _write_manifest(self, manifest: dict) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)
        tmp = self._manifest_path.with_name("manifest.json.tmp")
        tmp.write_text(json.dumps(manifest, indent=2, default=str) + "\n", encoding="utf-8")
        os.replace(tmp, self._manifest_path)


def _make_workspace_id(text: str) -> str:
    return f"{_slug(text)}-{time.strftime('%Y%m%d-%H%M%S')}-{secrets.token_hex(3)}"


def _slug(text: str) -> str:
    words = re.findall(r"[A-Za-z0-9]+", text.lower())
    return "_".join(words)[:40] or "task"


def _stamp() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


def _rel(root: Path, path: Path) -> str:
    try:
        return str(path.relative_to(root))
    except ValueError:
        return str(path)
