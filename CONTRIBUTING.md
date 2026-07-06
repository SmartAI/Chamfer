# Contributing to chamfer

Thanks for your interest! chamfer is a small, plain-Python CAD agent harness.
This guide covers the local setup, the checks your change must pass, and how to
run a full end-to-end test before you open a PR.

The package is published to PyPI as **`chamfer-cad`**; the CLI command, the
import names, and the repository are all `chamfer`.

## 1. Environment setup

You need [uv](https://docs.astral.sh/uv/) and Python **3.11+**.

```bash
git clone https://github.com/SmartAI/Chamfer.git
cd Chamfer
uv sync --group dev        # creates .venv and installs runtime + dev deps
```

Everything runs through `uv run` — you don't need to activate the venv.

The test suite is fully offline: no API key, no network, no CAD backend. It also
never touches your real `~/.chamfer` (`tests/conftest.py` redirects
`CHAMFER_HOME` to a temp dir and disables first-run seeding).

## 2. Project layout

The source is flat under `src/` (`src/cli.py`, `src/agent.py`, `src/tools.py`,
the `src/verify/` package, `src/mcp_tools.py`, …). For a module-by-module map and
the design invariants, read **[`AGENTS.md`](AGENTS.md)** — it's the canonical
reference for how the code is organized and the rules to keep.

## 3. Required checks

Both of these run in CI and must pass:

```bash
uv run ruff check .              # lint — REQUIRED (CI gates on this)
uv run --group dev pytest -q     # tests — REQUIRED (matrix: py3.11 / 3.12 / 3.13)
```

Formatting is handled by ruff; run it before committing (recommended, not yet
CI-gated):

```bash
uv run ruff format .
```

## 4. Code style

- **Formatter/linter:** [ruff](https://docs.astral.sh/ruff/). Config lives in
  `pyproject.toml` (`line-length = 120`, rules `E, F, W, I, UP`). `ruff check`
  must be clean; let `ruff format` handle layout.
- **Small and focused.** Prefer existing patterns over new abstractions unless
  the abstraction removes real complexity.
- **The core harness stays CAD-agnostic.** CAD capability comes from external
  MCP servers + skills, never hardcoded into the harness.
- **Determinism decides truth.** Never weaken acceptance checks into LLM
  self-reporting; the kernel verifier is the source of truth.
- `src/tools.py` is the tool-vocabulary source of truth; prompts render from it.
- Consequential/critical actions go through `ActionPolicy` (`src/policy.py`).
- Agent-facing dimensions are millimeters.
- Don't commit runtime output or local config (`~/.chamfer`, `runs/`,
  `.chamfer/`, `.mcp.json` are already git-ignored).

## 5. Fresh end-to-end test (local)

Beyond the unit suite, verify a real install works end to end. This builds the
wheel, installs it into a throwaway venv, and exercises the first-run seeding
plus local/global skill & MCP discovery — all isolated from your real home.

```bash
# 1. Build and install into a throwaway venv
uv build --wheel
uv venv /tmp/chamfer-e2e
uv pip install --python /tmp/chamfer-e2e dist/*.whl

# 2. Isolate the home dir so nothing lands in your real ~/.chamfer
export CHAMFER_HOME=/tmp/chamfer-e2e-home
rm -rf "$CHAMFER_HOME"

# 3a. No-key smoke via the scripted provider (offline)
mkdir -p /tmp/e2e/replies
printf '```tool_call\n{"tool": "write", "params": {"path": "note.md", "content": "hi"}}\n```' \
  > /tmp/e2e/replies/response_1.json
printf 'Done.' > /tmp/e2e/replies/response_2.json
( cd /tmp/e2e && /tmp/chamfer-e2e/bin/chamfer run "a small bracket" \
    --provider scripted --scripted-dir replies )
#   -> first run seeds $CHAMFER_HOME/skills + $CHAMFER_HOME/mcp.json (build123d)

# 3b. Real build with an LLM provider + the seeded build123d MCP (needs a key
#     and network; downloads build123d-mcp on first use)
export ANTHROPIC_API_KEY=...      # or OPENAI_API_KEY / OPEN_ROUTER_API
/tmp/chamfer-e2e/bin/chamfer run "a 2 L kettle with a rounded rim" \
  --provider anthropic -o /tmp/e2e/kettle.step

# 4. Clean up
rm -rf /tmp/chamfer-e2e /tmp/chamfer-e2e-home /tmp/e2e dist
```

To test **project-local** overrides, add `.chamfer/skills/<name>/SKILL.md` or a
`.mcp.json` in the working directory — they take precedence over the global
`~/.chamfer` (i.e. `$CHAMFER_HOME`) versions. A project `CHAMFER.md` is folded
into the system prompt.

## 6. Pull requests

1. Branch from `main`.
2. Make your change; keep it focused.
3. Ensure `uv run ruff check .` and `uv run --group dev pytest` both pass.
4. Open the PR with a clear description of what and why. CI (lint + test matrix +
   build) must be green before merge.

## 7. Releases (maintainers)

Versioning is git-tag driven (hatch-vcs). To cut a release, push a `vX.Y.Z` tag:
the `Release` workflow builds, tests, and publishes `chamfer-cad` to PyPI via
trusted publishing, then creates a GitHub Release. No version numbers are edited
by hand.
