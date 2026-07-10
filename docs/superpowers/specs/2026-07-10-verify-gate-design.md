# Deterministic Verify Gate — Design

Date: 2026-07-10
Status: approved (design conversation 2026-07-10)
Scope: Part B of the eval-leaderboard + verify-gate initiative. Part A (Playwright-driven
CADTestBench leaderboard, `evals/`) is a separate follow-up spec.

## Problem

The agent's only success criterion today is its own reading of the 7-view inspection sheet
and measurements. Nothing *enforces* that the geometry matches the plan: booleans that
silently ate half the part, wrong-direction extrudes, fillets that split the solid, and
multi-body fragmentation (a known v1 image-to-CAD failure) can all be declared "success".

## Approach

The harness gains a deterministic **verify gate**: executable checks over the produced
B-rep, evaluated after every run. The agent must declare its geometric intent in a
machine-checkable `# --- expect ---` block *before* building; the gate verifies outcome
against declared intent. The gate does not verify "matches what the user wanted" — that
remains the visual check's job — it verifies "matches the plan the agent committed to".

Philosophy is deliberately aligned with CADTestBench's CADTests (executable predicates
over the B-rep), so the future eval harness measures gate impact directly (gate off/on
ablation).

## The expect block

Mirrors the params-block convention: a delimited block containing one AST-parseable
assignment.

```python
# --- expect ---
EXPECT = {
    "bodies": 1,                      # required: expected solid count
    "bbox_mm": [64.0, 40.0, 12.0],    # required: overall dims, any order
    "bbox_tol": 0.5,                  # optional: absolute mm, default 0.5
    "volume_mm3": [18000, 26000],     # optional: [min, max] range
}
# --- end expect ---
```

- `bodies` (int >= 1, required): expected count of solids in `result`.
- `bbox_mm` (3 numbers, required): overall bounding-box dimensions. Compared **sorted**
  (orientation-agnostic) against the measured bbox, each within `bbox_tol`.
- `bbox_tol` (number > 0, optional, default 0.5): absolute tolerance in mm.
- `volume_mm3` ([min, max], optional): inclusive range for total volume.
- Unknown keys: reported as a failed `expect_block` check (typo protection).

Parsing: locate markers, `ast.parse`, find the single `EXPECT = {...}` assignment inside
the block, extract via `ast.literal_eval`. The block is real Python and also executes
harmlessly as part of the script.

### Always-on checks (no declaration needed)

- `valid`: `shape.is_valid()` on the resulting shape.
- `nondegenerate`: total volume > 0.

### Gate result shape

```
gate: {
  status: "passed" | "failed" | "error",
  checks: [{ name, passed, detail }]
}
```

- `failed`: at least one check failed (including missing/malformed expect block on a run).
- `error`: the gate evaluator itself threw — **fail-open**: a gate bug can never break
  model building, tessellation, or export. Reported with the exception detail.

## Enforcement path

1. `harness.run_script` gains a `gate` key (additive; all existing keys unchanged).
2. `CadResponse` for `run` gains optional `gate` field (`Gate`/`GateCheck` types in
   `@chamfer/shared`); `cad.worker.ts` and `cadClient.run` pass it through.
3. `run_build123d` tool result prepends a gate section to the text: pass ⇒ one line;
   fail ⇒ the failing checks with details and an instruction to fix before declaring
   success. The mesh/view sheet still renders either way (`onSuccess` unchanged).
4. System prompt: expect-block convention documented next to the params block; new hard
   rule in Verification Discipline — the agent may not present a result while the gate
   fails; a missing block is a gate failure; fixes consume the existing 10-run budget.
5. **Sliders don't fight the gate**: the harness computes `gate` on every run, but only
   the `run_build123d` tool surfaces/enforces it. The ParamsPanel `setParams`→re-run path
   ignores the field, so user slider edits never trip it. (Future work: let `EXPECT`
   reference param names so expectations scale with sliders.)

## Regression safety

1. **Additive & fail-open by construction** — no expect block ⇒ identical code path;
   `gate` is a new optional response field; evaluator wrapped so internal errors degrade
   to `status: "error"`.
2. **Existing net before/after** — `py-tests/`, all vitest workspaces, 7 Playwright
   specs; no existing assertion may be edited.
3. **Golden-output snapshot (Task 0, built first, against the unmodified harness)** —
   committed fixture capturing `run_script` measurements, mesh vertex/index counts,
   stdout, and `parse_params` output for representative scripts; must be byte-stable
   across the gate change (new `gate` key excluded from comparison by construction —
   snapshot compares the captured keys only).
4. **Performance guard** — golden scripts double as a timing baseline; gate checks
   (is_valid, volume, solids count, bbox) are trivial next to tessellation; verified by
   measurement once, not a flaky CI timing assert.
5. **TDD ordering** — gate tests (including "absence of block ⇒ run output unchanged")
   written first.

Known limit: model-*behavior* regression (does the new prompt rule make the agent worse?)
is only measurable by Part A; until then, spot-checked on preset prompts.

## Test plan

- `py-tests/test_golden.py` — snapshot regression (Task 0).
- `py-tests/test_gate.py` — expect parsing (valid / missing / malformed / non-dict /
  unknown keys / bad types / defaults), evaluation (bodies pass+fail, sorted-bbox
  order-insensitivity, tol edges, volume range, always-on checks), fail-open error path,
  and no-block ⇒ existing `run_script` keys unchanged.
- `packages/shared` — `Gate` types; `isCadResponse` untouched.
- Client vitest — `cadClient.run` gate passthrough; `runBuild123d` tool text for
  pass/fail/error gates.
- E2E — extend the fake-LLM agent-loop spec so a gate-failing script's tool result
  visibly reports the failure.

## Build order

0. Golden snapshot (on unmodified harness) → commit.
1. Gate in `harness.py` (tests first).
2. Shared types + worker + cadClient passthrough.
3. Tool text + system prompt.
4. E2E + full suite green.
