# Agent benchmarks

This directory is the single source of truth for evaluating Chamfer's agent.
The rule it exists to enforce: **no eval, no build** - every change to the agent (base loop, tools, skills, gates, prompts) must show its value here before it ships.

**The headline results live in [REPORT.md](REPORT.md)** - the July 2026 milestone report with the four-agent comparison, artifact gallery, and evidence.

## Why this exists

Chamfer v1's agent harness was built for weeks without a baseline or golden dataset.
When it was finally benchmarked (2026-07) against generic coding agents driving the same CAD tools over MCP, it lost on correctness for hard parts and lost badly on cost, and its added layers (tool mediation, forced inspections, heavy skills context) turned out to subtract value.
Nothing in this directory would have allowed that to stay invisible.

## Structure

- `golden/v1/cases.json` - the golden case set, tiered by difficulty (T0 smoke -> T4 multi-axis).
  Every expected value is validated against at least one real reference build before a case is added.
  Prompts are deliberately unambiguous about graded features; a golden set measures capability, not interpretation coin flips.
- `oracle/oracle.py` - the data-driven measurement grader.
  It imports each arm's exported STEP with real build123d and grades name-independent geometric facts only: body count, envelope, volume band, cylindrical features (radius, axis, count, through-state, positions), inclined faces.
  Run it with a Python environment that has build123d (the repo's `py-tests/.venv`).
- `results/` - committed run summaries, one directory per run: `results/<date>-<arm>-<model>/summary.json`.
  Never overwrite old results; the history is the point.

## Arms

An "arm" is an agent configuration under test. The standing comparison set:

1. **chamfer**: the Chamfer agent, headless, driving build123d-mcp's six curated tools (execute, last_error, inspect_part, measure, render_view, export), no skills, no context files.
   Frozen configurations live under `arms/` (`arms/v0/`, `arms/v1/`); an arm is fully defined by its system prompt and MCP config.
2. **reference**: Claude Code + the same MCP server and tool set.
3. **reference**: Codex + the same MCP server (different model family, so latency-comparable only).

All arms get the identical prompt, which includes the export-STEP-to-path contract; an arm that fails to export scores 0 on correctness.
Same model across arms for any comparison row; run arms sequentially.

## Metrics (captured per run)

| Metric | Definition |
|---|---|
| correctness | oracle checks passed / total (the primary metric) |
| over-claim | agent's final message claims completion while correctness < 100% |
| cost (USD) | provider-reported or catalog-priced token cost |
| tokens | input (cache-inclusive) and output |
| tool calls | total tool invocations (and executes separately) |
| latency | wall-clock seconds from prompt to agent exit |

## Running

```bash
# one arm over the full dev set, N=3 (runner names: pi = the Chamfer agent arm, claude, codex)
node benchmarks/runners/runBatch.mjs --arm=pi --arm-dir=benchmarks/arms/v1 --cases=all --reps=3
# single case, single run
node benchmarks/runners/piRun.mjs --case=GOLD-T3-BEARING-HOUSING --arm-dir=benchmarks/arms/v1
```

Credentials come strictly from the environment (`ANTHROPIC_API_KEY`; optional `ANTHROPIC_BASE_URL`).
Summaries land in `results/<timestamp>-<arm>-<model>/summary.json`; raw per-run transcripts and STEP exports stay in the git-ignored `results/tmp-runs/`.

## Method rules

- N=1 is a smoke signal, not a result; use >= 3 repetitions before claiming a difference between arms.
- Grade geometry only through the oracle; never trust an agent's self-report of correctness.
- When an oracle check turns out to punish a legitimate interpretation (frame placement, rim chamfers, axis reading), fix the oracle for ALL arms and re-grade everything - and note the change here.
- Expected values for a new case must be validated by building a reference part first (see `golden/v1/cases.json` notes).
- Results from different golden-set versions are not comparable; bump the version directory instead of editing cases in place.

## History

- 2026-07-23: v1 golden set created from the two cross-agent bench rounds (Fusion MCP round; build123d MCP round).
  Oracle calibration fixtures: a known-good circular-pocket plate scores 9/9 on T2 and a known square-pocket build fails exactly the two pocket checks; a known-good housing scores 11/11 on T3 and a known envelope-only build scores 3/11.
- 2026-07-23 (later): golden set expanded to tier 4 after the baseline saturated tiers 0-3; a private held-out test set (one case per tier, never committed) was created behind a freeze-before-test firewall.
- 2026-07-23/24: four-arm held-out showdown (Chamfer v0/v1, Claude Code, Codex) and the milestone [REPORT.md](REPORT.md).
  Two efficiency probes (low thinking budget, compressed prompt + trimmed verification) were run on dev and REJECTED for correctness/over-claim regressions; verdicts and evidence in `V1-PLAN.md`.
