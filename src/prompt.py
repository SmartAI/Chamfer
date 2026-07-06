"""System prompt rendering and provider-neutral prompt cache keys."""

from __future__ import annotations

import hashlib
import json
import time
from dataclasses import dataclass

from resources import ProjectInstruction, Skill, render_skills_block
from tools import ToolRegistry

HEADER = """\
You are Chamfer, a small text-to-CAD harness agent.

Use exactly one fenced tool call when you need a tool:

```tool_call
{"tool": "<tool name>", "params": {...}}
```

Rules:
- One tool call per reply.
- No tool call means the stage is complete or blocked.
- Report honestly when CAD execution or verification tools are unavailable.
- Consequential and critical actions are governed by the action policy.
- Do not expose private chain-of-thought. Do emit concise, user-facing progress
  notes before tool calls: what you are building/checking and why.
- For CAD work, build bottom-up, name distinct components, and verify with
  available CAD tools. Prefer measured tool output over self-reported claims.
- Use millimeters. Build nominal dimensions from the request explicitly, then
  measure the resulting solids for bounding boxes, volumes, clearances, hole
  diameters/positions, and component counts before reporting success.
- For assembled products, verify physical relationships when tools are available:
  intended touching/connection or clearance, no floating unintended components,
  no unwanted intersections/crossovers, and no unstitched gaps in parts that
  should be joined.
- Keep final deliverables as real solids or assemblies of solids. Avoid
  visual-only, mesh-only, or placeholder geometry unless no solid CAD tool is
  available, and report that limitation honestly.
- For appearance-sensitive CAD work, assign explicit per-component colours before
  export. With build123d, set each named object's `.color`; STEP can carry RGB
  colour, but not procedural brushed or matte texture maps.
- When a request names distinct components and asks for STEP, export the named
  final components rather than only an aggregate compound. With build123d,
  use object_name="*" after registering the intended final named objects.
- If `read_mcp_resource` is available, use it to read relevant MCP reference
  resources such as `build123d://quickref` before writing nontrivial CAD code.
- Before final export, validate solids when a validation tool is available.
- If visual appearance matters and a render tool is available, render before
  export to catch obvious colour, placement, or shape errors.
- Final replies for CAD deliverables must include:
  deliverable paths, component summary, measured dimensions/capacity/clearances,
  verification results, and any format limitations such as STEP colour versus
  procedural material texture.
"""


@dataclass(frozen=True)
class PromptCacheStrategy:
    key: str
    parts: dict


def build_system_prompt(
    *,
    tools: ToolRegistry,
    skills: tuple[Skill, ...] = (),
    instructions: tuple[ProjectInstruction, ...] = (),
    mcp_instructions: tuple[ProjectInstruction, ...] = (),
    cwd: str,
    workflow_name: str = "agent",
    date: str | None = None,
) -> str:
    """Assemble the system prompt in a fixed layered order:

    built-in instruction (HEADER) -> tools (built-in + MCP) -> MCP server
    instructions/resources -> user-provided project instructions (CHAMFER.md)
    -> skills (first layer only; bodies read on demand) -> footer.

    The conversation (user input) is appended after this system prompt by the
    caller, so the effective order is exactly:
    system + tools + mcp + CHAMFER.md + skills + user input.
    """
    tool_block = "\n".join(
        f"- {tool.name}: {tool.description}\n"
        f"  risk: {tool.risk}\n"
        f"  sandbox: {tool.sandbox_profile or 'read_only'}\n"
        f"  params schema: {json.dumps(tool.input_schema, sort_keys=True)}"
        for tool in tools.specs()
    )
    parts = [HEADER, "TOOLS:\n" + tool_block]
    mcp_block = _render_instruction_block(mcp_instructions, "mcp_context", "mcp_instructions")
    if mcp_block:
        parts.append(mcp_block)
    project_block = _render_instruction_block(instructions, "project_context", "project_instructions")
    if project_block:
        parts.append(project_block)
    skills_block = render_skills_block(skills)
    if skills_block:
        parts.append(skills_block)
    parts.append(f"Workflow: {workflow_name}\nWorking directory: {cwd}\nDate: {date or time.strftime('%Y-%m-%d')}")
    return "\n\n".join(parts)


def _render_instruction_block(
    instructions: tuple[ProjectInstruction, ...],
    outer_tag: str,
    inner_tag: str,
) -> str:
    if not instructions:
        return ""
    blocks = "\n".join(
        f'<{inner_tag} path="{item.path}" unsafe="{str(item.unsafe).lower()}">\n'
        f"{item.content}\n</{inner_tag}>"
        for item in instructions
    )
    return f"<{outer_tag}>\n{blocks}\n</{outer_tag}>"


def prompt_cache_strategy(
    *,
    system_prompt: str,
    tools: ToolRegistry,
    skills: tuple[Skill, ...],
    instructions: tuple[ProjectInstruction, ...],
    workflow_name: str,
    model: str,
    sandbox_policy_summary: dict,
    mcp_instructions: tuple[ProjectInstruction, ...] = (),
) -> PromptCacheStrategy:
    parts = {
        "system_prompt": system_prompt,
        "tools": [
            {
                "name": tool.name,
                "description": tool.description,
                "input_schema": tool.input_schema,
                "risk": tool.risk,
                "sandbox_profile": tool.sandbox_profile,
            }
            for tool in tools.specs()
        ],
        "skills": [
            {"name": skill.name, "description": skill.description, "path": skill.path}
            for skill in skills
        ],
        "instructions": [
            {"path": item.path, "content": item.content, "unsafe": item.unsafe}
            for item in instructions
        ],
        "mcp_instructions": [
            {"path": item.path, "content": item.content, "unsafe": item.unsafe}
            for item in mcp_instructions
        ],
        "workflow_name": workflow_name,
        "model": model,
        "sandbox_policy_summary": sandbox_policy_summary,
    }
    encoded = json.dumps(parts, sort_keys=True, default=str).encode()
    return PromptCacheStrategy(
        key=hashlib.sha256(encoded).hexdigest(),
        parts=parts,
    )
