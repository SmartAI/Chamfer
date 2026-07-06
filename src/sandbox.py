"""First-version sandbox profiles and command runner.

This is process/filesystem discipline, not a security boundary. Stronger
container or remote isolation can be added behind the same profile shape.
"""

from __future__ import annotations

import os
import subprocess
from dataclasses import dataclass, field, replace
from pathlib import Path


@dataclass(frozen=True)
class SandboxProfile:
    name: str
    cwd: Path
    readable_roots: tuple[Path, ...]
    writable_roots: tuple[Path, ...] = ()
    env: dict[str, str] = field(default_factory=dict)
    timeout_s: float = 120.0
    network: str = "inherit"
    process_limit: int | None = None
    cleanup: str = "none"

    def normalized(self) -> SandboxProfile:
        return replace(
            self,
            cwd=self.cwd.resolve(),
            readable_roots=tuple(p.resolve() for p in self.readable_roots),
            writable_roots=tuple(p.resolve() for p in self.writable_roots),
        )

    def resolve_read_path(self, path: str | Path) -> Path:
        return self._resolve_allowed(path, self.readable_roots, "read")

    def resolve_write_path(self, path: str | Path) -> Path:
        return self._resolve_allowed(path, self.writable_roots, "write")

    def effective_env(self) -> dict[str, str]:
        return {**os.environ, **self.env}

    def summary(self) -> dict:
        normalized = self.normalized()
        return {
            "name": normalized.name,
            "cwd": str(normalized.cwd),
            "readable_roots": [str(p) for p in normalized.readable_roots],
            "writable_roots": [str(p) for p in normalized.writable_roots],
            "env_keys": sorted(normalized.env),
            "timeout_s": normalized.timeout_s,
            "network": normalized.network,
            "cleanup": normalized.cleanup,
        }

    def _resolve_allowed(
        self,
        path: str | Path,
        roots: tuple[Path, ...],
        action: str,
    ) -> Path:
        normalized = self.normalized()
        raw = Path(path)
        candidate = (raw if raw.is_absolute() else normalized.cwd / raw).resolve()
        allowed_roots = tuple(root.resolve() for root in roots)
        if not any(_is_relative_to(candidate, root) for root in allowed_roots):
            root_list = ", ".join(str(root) for root in allowed_roots) or "<none>"
            raise PermissionError(
                f"{action} path escapes sandbox roots: {candidate} "
                f"(allowed: {root_list})"
            )
        return candidate


@dataclass(frozen=True)
class SandboxResult:
    ok: bool
    output: str
    exit_code: int | None = None
    full_output_path: Path | None = None


class SandboxRunner:
    def run_bash(
        self,
        command: str,
        profile: SandboxProfile,
        *,
        timeout_s: float | None = None,
        full_output_path: Path | None = None,
        max_lines: int = 2000,
        max_bytes: int = 50 * 1024,
    ) -> SandboxResult:
        normalized = profile.normalized()
        normalized.resolve_read_path(normalized.cwd)
        effective_timeout = timeout_s or normalized.timeout_s
        try:
            proc = subprocess.run(
                command,
                shell=True,
                cwd=normalized.cwd,
                capture_output=True,
                text=True,
                timeout=effective_timeout,
                env=normalized.effective_env(),
            )
        except subprocess.TimeoutExpired:
            return SandboxResult(
                ok=False,
                output=f"error: command timed out after {effective_timeout:.0f}s",
            )
        full = (proc.stdout + proc.stderr).strip()
        artifact = None
        if full_output_path is not None:
            full_output_path.parent.mkdir(parents=True, exist_ok=True)
            full_output_path.write_text(full + ("\n" if full else ""), encoding="utf-8")
            artifact = full_output_path
        body, truncated = truncate_tail(full, max_lines=max_lines, max_bytes=max_bytes)
        note = "\n... (truncated: output tail shown)" if truncated else ""
        if artifact is not None and truncated:
            note += f"\nfull output: {artifact}"
        return SandboxResult(
            ok=proc.returncode == 0,
            output=f"{body}{note}\nexit code: {proc.returncode}",
            exit_code=proc.returncode,
            full_output_path=artifact,
        )


def default_profiles(root: str | Path) -> dict[str, SandboxProfile]:
    base = Path(root).resolve()
    return {
        "read_only": SandboxProfile(
            name="read_only",
            cwd=base,
            readable_roots=(base,),
            writable_roots=(),
            network="off",
        ),
        "workspace_write": SandboxProfile(
            name="workspace_write",
            cwd=base,
            readable_roots=(base,),
            writable_roots=(base,),
            network="off",
        ),
        "test": SandboxProfile(
            name="test",
            cwd=base,
            readable_roots=(base,),
            writable_roots=(base,),
            env={"PYTHONDONTWRITEBYTECODE": "1"},
            timeout_s=300.0,
            network="off",
        ),
        "network_off": SandboxProfile(
            name="network_off",
            cwd=base,
            readable_roots=(base,),
            writable_roots=(base,),
            network="off",
        ),
        "external_app": SandboxProfile(
            name="external_app",
            cwd=base,
            readable_roots=(base,),
            writable_roots=(base,),
            timeout_s=600.0,
            network="inherit",
        ),
    }


def permissive_profiles(root: str | Path) -> dict[str, SandboxProfile]:
    """Sandbox-disabled profiles: run in `root` but allow read/write anywhere.

    Path-escape checks are widened to the filesystem root so the agent can read
    and write arbitrary absolute paths (e.g. a user-chosen STEP destination).
    Network is inherited. This removes the filesystem discipline the default
    profiles provide; use only when the caller has opted out of the sandbox.
    """

    base = Path(root).resolve()
    fs_root = Path(base.anchor or "/")
    return {
        name: replace(
            profile,
            readable_roots=(fs_root,),
            writable_roots=(fs_root,),
            network="inherit",
        )
        for name, profile in default_profiles(base).items()
    }


def truncate_head(
    text: str,
    *,
    max_lines: int = 2000,
    max_bytes: int = 50 * 1024,
) -> tuple[str, bool]:
    lines = text.splitlines()
    kept, size = [], 0
    for line in lines[:max_lines]:
        size += len(line.encode()) + 1
        if size > max_bytes:
            break
        kept.append(line)
    return "\n".join(kept), len(kept) < len(lines)


def truncate_tail(
    text: str,
    *,
    max_lines: int = 2000,
    max_bytes: int = 50 * 1024,
) -> tuple[str, bool]:
    lines = text.splitlines()
    kept, size = [], 0
    for line in reversed(lines[-max_lines:]):
        size += len(line.encode()) + 1
        if size > max_bytes:
            break
        kept.append(line)
    kept.reverse()
    return "\n".join(kept), len(kept) < len(lines)


def _is_relative_to(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False
