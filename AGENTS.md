# Repository Instructions

This file is for Codex and other agents working on **this repository**.
It is not shipped with the package. Keep it short.

(Separately, an end user of the CLI may drop a `CHAMFER.md` in their own project
to add runtime instructions to the agent's system prompt. This repo does not
ship one; the base system instruction lives in code — `src/prompt.py`.)

## What this is

chamfer is a small, plain-Python CAD agent harness. The LLM drives an external
CAD MCP server (build123d by default) to build geometry from a prompt, and a
deterministic verifier decides PASS. No agent framework.

## Layout (flat `src/`)

- `src/cli.py` — entry point (`chamfer run`); wires providers, MCP discovery,
  skills, and the workflow. Composition root.
- `src/agent.py`, `src/workflow.py`, `src/session.py` — the agent loop and the
  text-to-CAD workflow stages.
- `src/tools.py` — local tools + the `ToolRegistry`; the source of truth for
  tool vocabulary. Prompts render from it (`src/prompt.py`).
- `src/mcp_tools.py` — generic bridge that registers any configured MCP server's
  tools. `src/mcp_config.py`, `src/mcp_stdio.py` — config discovery + transport.
- `src/verify/` — the tiered STEP verifier (`spec`, `step_reader`, `tiered`) and
  the `verify_step` tool (`verify/tool.py`).
- `src/home.py` — `~/.chamfer` provisioning (default skills + MCP config seeded
  on first run) and skill-dir layering.
- `src/policy.py`, `src/sandbox.py`, `src/resources.py`, `src/llm.py`,
  `src/evidence.py`, `src/observability.py`, `src/workspace.py` — supporting
  modules.
- `skills/` — default skills (Markdown `SKILL.md`), shipped and seeded to
  `~/.chamfer/skills`. `tests/` — the offline test suite.

## Non-negotiables

- Deterministic verification decides truth; never weaken acceptance checks into
  LLM self-reporting.
- Keep changes simple, focused, and extensible. Prefer existing patterns over
  new abstractions unless the abstraction removes real complexity.
- The core harness stays CAD-agnostic: CAD capability comes from external MCP
  servers + skills, not hardcoded in the harness.
- `src/tools.py` is the tool-vocabulary source of truth; prompts render from it.
- Consequential/critical actions go through `ActionPolicy` (`src/policy.py`).
- Agent-facing dimensions are millimeters.
- Run `uv run --group dev pytest` before claiming code changes work. The suite
  is offline (no key, no network); `tests/conftest.py` isolates `~/.chamfer`.
- Do not commit, push, delete branches, or revert unrelated changes unless the
  user explicitly asks.
