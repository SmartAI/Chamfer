"""Project instruction, skill, and prompt-template loading."""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import Path

MAX_DESCRIPTION = 1024
INSTRUCTION_FILE = "CHAMFER.md"
PROMPT_INJECTION_PATTERNS = (
    re.compile(r"\bignore (all )?(previous|prior|above) instructions\b", re.I),
    re.compile(r"\bdeveloper message\b", re.I),
    re.compile(r"\bsystem prompt\b", re.I),
    re.compile(r"\breveal .*instructions\b", re.I),
    re.compile(r"\btool_call\b.*\bwithout\b.*\bapproval\b", re.I),
)


@dataclass(frozen=True)
class ProjectInstruction:
    path: str
    content: str
    unsafe: bool = False


@dataclass(frozen=True)
class Skill:
    name: str
    description: str
    path: str
    body: str = ""
    platform: tuple[str, ...] = ()
    environment: tuple[str, ...] = ()
    required_tools: tuple[str, ...] = ()
    required_capabilities: tuple[str, ...] = ()
    unsafe: bool = False


@dataclass(frozen=True)
class ResourceSet:
    instructions: tuple[ProjectInstruction, ...]
    skills: tuple[Skill, ...]
    prompt_templates: dict[str, str]


class Sanitizer:
    def sanitize(self, text: str) -> tuple[str, bool]:
        unsafe = False
        cleaned: list[str] = []
        for line in text.splitlines():
            if any(pattern.search(line) for pattern in PROMPT_INJECTION_PATTERNS):
                cleaned.append("[sanitized unsafe instruction line]")
                unsafe = True
            else:
                cleaned.append(line)
        return "\n".join(cleaned), unsafe


class ResourceLoader:
    def __init__(
        self,
        *,
        cwd: str | Path,
        skill_dirs: tuple[str | Path, ...] = (),
        prompt_dirs: tuple[str | Path, ...] = (),
        materialized_skill_dir: str | Path | None = None,
        sanitizer: Sanitizer | None = None,
    ) -> None:
        self.cwd = Path(cwd).resolve()
        self.skill_dirs = tuple(Path(p) for p in skill_dirs)
        self.prompt_dirs = tuple(Path(p) for p in prompt_dirs)
        self.materialized_skill_dir = (
            Path(materialized_skill_dir) if materialized_skill_dir is not None else None
        )
        self.sanitizer = sanitizer or Sanitizer()

    def load(
        self,
        *,
        available_tools: set[str] | None = None,
        available_capabilities: set[str] | None = None,
        platform: str | None = None,
        environment: str | None = None,
        session_id: str = "",
    ) -> ResourceSet:
        return ResourceSet(
            instructions=tuple(self.load_project_instructions()),
            skills=tuple(
                self.load_skills(
                    available_tools=available_tools or set(),
                    available_capabilities=available_capabilities or set(),
                    platform=platform or os.name,
                    environment=environment or "local",
                    session_id=session_id,
                )
            ),
            prompt_templates=self.load_prompt_templates(),
        )

    def load_project_instructions(self) -> list[ProjectInstruction]:
        found: list[ProjectInstruction] = []
        directory = self.cwd
        while True:
            candidate = directory / INSTRUCTION_FILE
            if candidate.is_file():
                content, unsafe = self.sanitizer.sanitize(
                    candidate.read_text(encoding="utf-8")
                )
                found.append(ProjectInstruction(str(candidate), content, unsafe=unsafe))
            if directory.parent == directory:
                return found
            directory = directory.parent

    def load_skills(
        self,
        *,
        available_tools: set[str],
        available_capabilities: set[str],
        platform: str,
        environment: str,
        session_id: str,
    ) -> list[Skill]:
        seen: dict[str, Skill] = {}
        for root in self.skill_dirs:
            if not root.is_dir():
                continue
            for skill_file in sorted(root.rglob("SKILL.md")):
                skill = self._load_skill_file(skill_file, session_id=session_id)
                if skill is None or skill.name in seen:
                    continue
                if not _metadata_allows(
                    skill,
                    available_tools=available_tools,
                    available_capabilities=available_capabilities,
                    platform=platform,
                    environment=environment,
                ):
                    continue
                seen[skill.name] = skill
        return list(seen.values())

    def load_prompt_templates(self) -> dict[str, str]:
        templates: dict[str, str] = {}
        for root in self.prompt_dirs:
            if not root.is_dir():
                continue
            for path in sorted(root.rglob("*.md")):
                rel = str(path.relative_to(root))
                content, _ = self.sanitizer.sanitize(path.read_text(encoding="utf-8"))
                templates[rel] = content
        return templates

    def _load_skill_file(self, skill_file: Path, *, session_id: str) -> Skill | None:
        raw = skill_file.read_text(encoding="utf-8")
        front = _parse_frontmatter(raw)
        description = front.get("description", "")
        if not description or len(description) > MAX_DESCRIPTION:
            return None
        body, unsafe = self.sanitizer.sanitize(raw)
        processed = _preprocess_skill(
            body,
            skill_dir=str(skill_file.parent.resolve()),
            session_id=session_id,
        )
        name = front.get("name") or skill_file.parent.name
        path = skill_file.resolve()
        if self.materialized_skill_dir is not None:
            path = self._materialize_skill(skill_file, processed)
        return Skill(
            name=name,
            description=description,
            path=str(path),
            body=processed,
            platform=_csv(front.get("platform", "")),
            environment=_csv(front.get("environment", "")),
            required_tools=_csv(front.get("required_tools", "")),
            required_capabilities=_csv(front.get("required_capabilities", "")),
            unsafe=unsafe,
        )

    def _materialize_skill(self, source: Path, body: str) -> Path:
        assert self.materialized_skill_dir is not None
        digest = re.sub(r"[^A-Za-z0-9_.-]+", "-", str(source.resolve())).strip("-")
        out = self.materialized_skill_dir / digest
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(body + ("\n" if not body.endswith("\n") else ""), encoding="utf-8")
        return out.resolve()


def render_skills_block(skills: list[Skill] | tuple[Skill, ...]) -> str:
    if not skills:
        return ""
    entries = "\n".join(
        f"  <skill>\n"
        f"    <name>{s.name}</name>\n"
        f"    <description>{s.description}</description>\n"
        f"    <location>{s.path}</location>\n"
        f"  </skill>"
        for s in skills
    )
    return (
        "<available_skills>\n"
        "Use skill descriptions as concise guidance. Do not spend tool calls "
        "reading skill files unless the task is blocked without the full body.\n"
        f"{entries}\n</available_skills>"
    )


def _parse_frontmatter(text: str) -> dict[str, str]:
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}
    fields: dict[str, str] = {}
    for line in lines[1:]:
        if line.strip() == "---":
            return fields
        if ":" in line:
            key, _, value = line.partition(":")
            fields[key.strip()] = value.strip()
    return {}


def _csv(text: str) -> tuple[str, ...]:
    return tuple(item.strip() for item in text.split(",") if item.strip())


def _metadata_allows(
    skill: Skill,
    *,
    available_tools: set[str],
    available_capabilities: set[str],
    platform: str,
    environment: str,
) -> bool:
    if skill.platform and platform not in skill.platform:
        return False
    if skill.environment and environment not in skill.environment:
        return False
    if skill.required_tools and not set(skill.required_tools) <= available_tools:
        return False
    if (
        skill.required_capabilities
        and not set(skill.required_capabilities) <= available_capabilities
    ):
        return False
    return True


def _preprocess_skill(text: str, *, skill_dir: str, session_id: str) -> str:
    return (
        text.replace("${CHAMFER_SKILL_DIR}", skill_dir)
        .replace("${CHAMFER_SESSION_ID}", session_id)
    )
