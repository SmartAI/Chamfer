# v0 weakness analysis (dev set, 21 saturated runs)

Scope: the 21 dev-set runs behind `benchmarks/results/20260723T190454Z-pi-claude-opus-4-8/summary.json` (T0-BOX, T1-PLATE, T2-POCKET-PLATE, T3-BEARING-HOUSING, N=3) and `benchmarks/results/20260723T191642Z-pi-claude-opus-4-8/summary.json` (T1B-LBRACKET, T2B-FLANGE, T3B-DRILLBLOCK, N=3).
All 21 runs scored 100% (checks 3/3 to 11/11) with zero over-claims, so per the pre-registered method this analysis targets efficiency, robustness margins, and latent habits only.
Evidence sources per run: `record.json`, `grade.json`, `transcript.jsonl`, and the pi session `.jsonl` under `benchmarks/results/tmp-runs/pi-GOLD-*`.
No file under `benchmarks/private/` was read.

## 1. Efficiency decomposition

Suite totals: 911 s wall, $2.04, 108 tool calls (48 execute, 21 inspect_part, 18 render_view, 21 export, 0 measure, 0 last_error).
Latency splits ~68% LLM time / ~32% tool time overall; cost splits ~46% output tokens ($25/M), ~33% cache write ($6.25/M), ~21% cache read ($0.5/M).

Per case (mean per run, N=3):

| Case | Wall | LLM | Tool | Cost | Calls | Exec | Failed exec | Reasoning share of out-tokens |
|---|---|---|---|---|---|---|---|---|
| T0-BOX | 14.8 s | 9.9 s | 4.1 s | $0.037 | 3.0 | 2.0 | 3/3 runs | 0% |
| T1-PLATE | 31.4 s | 8.7 s | 21.7 s | $0.062 | 5.3 | 2.0 | 2/3 runs | 0% |
| T2-POCKET-PLATE | 60.9 s | 34.4 s | 24.1 s | $0.125 | 6.7 | 3.0 | 1/3 runs | 24% |
| T3-BEARING-HOUSING | 88.3 s | 75.1 s | 12.0 s | $0.207 | 6.7 | 3.7 | 0/3 runs | 55% |
| T1B-LBRACKET | 39.8 s | 27.1 s | 11.9 s | $0.082 | 4.0 | 1.0 | 0/3 runs | 34% |
| T2B-FLANGE | 32.0 s | 18.6 s | 12.4 s | $0.075 | 4.3 | 1.3 | 1/3 runs | 3% |
| T3B-DRILLBLOCK | 36.6 s | 25.0 s | 10.7 s | $0.092 | 6.0 | 3.0 | 3/3 runs | 10% |

Tool-call latency and context weight (across all 21 runs):

| Tool | Calls | Mean dur | Result payload | Notes |
|---|---|---|---|---|
| execute | 48 | 1.3 s | ~366 chars | result auto-echoes volume/bbox/face count (free measured feedback) |
| inspect_part | 21 | 2.1 s | ~1,448 chars | the only measured verification actually used |
| render_view | 18 | 5.8 s | image (~1,150 cache-write tokens each) | slowest tool; 0 model changes ever followed a render |
| export | 21 | 3.9 s | ~173 chars | echoes volume/bbox/faces of the exported model |

Failed tool calls: 15 total (11 execute, 4 inspect_part) affecting 11/21 runs (52%).
Measured retry latency (failed call to next successful attempt) is ~48 s for the execute failures alone, ~56 s (~6% of suite wall) including the inspect retries.
Genuinely redundant calls are rare: one no-op re-registration (`b = b2; show(b, ...)` in T3B r2) and the double inspect_part calls are schema-error retries, not re-verification of verified state.
No doc-lookup-style exploration occurred in any run.

Where the money actually goes: output tokens are 46% of suite cost, and on the expensive case (T3) 57% of cost is output tokens of which 55% is hidden reasoning (thinkingLevel medium).
So verification is NOT where cost lives: inspect+render+export together are ~25% of wall and ~15% of cost, and the only cheap-to-remove piece is the render ritual (see F5).

**Single biggest cost/latency reducer that preserves verification: demote the mandatory render_view to a conditional single render (F5).**
It saves ~5.8 s + ~$0.008 per affected run (-11.5% suite wall, -6-7% suite cost) while keeping inspect_part (measured) plus the export echo, satisfying the "at least one measured verification + export" floor.
Explicit flag: cutting verification deeper would not help - the dominant cost is LLM reasoning/generation on hard geometry, and inspect_part demonstrably catches real defects (T2-POCKET r3's chamfer collateral, section 3).

## 2. Findings table

Run-dir refs are under `benchmarks/results/tmp-runs/`.

| # | Finding | Evidence (run dirs) | Freq | Cost/latency | v1 intervention (small) | Expected movement |
|---|---|---|---|---|---|---|
| F1 | First execute fails with `NameError` because `from build123d import *` is missing | pi-GOLD-T0-BOX-r1/r2/r3, pi-GOLD-T1-PLATE-r1/r2 | 5/21 runs | +1 turn, 3.7-6.1 s each (~24 s total) | Prompt line: "Start every execute() with `from build123d import *`." | -5 failed calls; -25-30% wall on T0-class runs |
| F2 | MCP tool names called as Python inside execute (`inspect_part()` NameError x2; in-sandbox `measure()` exists but has a different schema, `KeyError: 'bounding_box'`) | pi-GOLD-T1-PLATE-r2-1784833584225, pi-GOLD-T3B-DRILLBLOCK-r3-1784834519394 | 3 events / 2 runs | ~9 s + 2 turns | Prompt line: "inspect_part/render_view/export are MCP tools, not Python names; never call them inside execute()." | -3 failed calls |
| F3 | Sandbox blocks hit: `getattr` for edge filtering; `__import__('math')` although plain `import math` is allowed | pi-GOLD-T2-POCKET-PLATE-r1-1784833657724, pi-GOLD-T2B-FLANGE-r1-1784834334733 | 2/21 runs | ~17 s + 2 turns | Prompt line: "math/numpy import normally; getattr/eval/exec/`__import__` are blocked, hasattr/dir are fine." | -2 failed calls |
| F4 | inspect_part `expected` diff attempted with wrong schema (`"axis":"Z"` instead of `[0,0,1]`) then the feature is abandoned for plain inspection | pi-GOLD-T1-PLATE-r2, pi-GOLD-T1-PLATE-r3-1784833619552, pi-GOLD-T2B-FLANGE-r1 | 3/21 runs | 3 failed calls; loses the tool's built-in expected-vs-actual diff | Prompt line with one worked example: `expected.holes[].axis` is a 3-number array | Converts 3 failures into working diff verification; strengthens the gate at zero added calls |
| F5 | Mandatory render_view is a checkbox ritual: 18 renders, comments always follow but zero model changes ever result | all runs except T0 (e.g. pi-GOLD-T1B-LBRACKET-r1/r2/r3) | 18/21 runs | 104 s (11.5% suite wall) + ~1,150 image tokens each (~$0.14, 7% suite cost) | Prompt rule: "render_view once, after inspect_part passes, only when features exist that a bbox/hole inventory cannot confirm; skip otherwise." | -11.5% wall, -6-7% cost; verification floor kept (inspect_part + export echo) |
| F6 | Verification skipped entirely on trivial parts despite prompt mandate; "Verified." claimed from the execute echo alone | pi-GOLD-T0-BOX-r1/r2/r3 | 3/21 runs | none (saved time) | Prompt line: "Always run inspect_part before export, even for trivial parts." (renders governed by F5) | Removes the instruction-decay habit that becomes over-claim risk at higher tiers |
| F7 | Zero assumption statements in 21/21 runs while structurally divergent interpretations shipped silently: T3 bearing bore along X in r1/r2 but along Y in r3, recess face +X vs -Y, volume spread 5.4k mm3 | pi-GOLD-T3-BEARING-HOUSING-r1/r2/r3 (grade.json face axes) | 21/21 runs; 1/7 cases diverged | none on dev (checks accept any horizontal axis) | Prompt line: "If the request leaves an axis/facing/frame choice open, state the chosen assumption in one line before building." | Turns tier-4 coin-flips into pinned, reviewable decisions (targets H2) |
| F8 | Positions recited from input variables, never measured: final claims quote code constants ("holes at X=45, Y=8/32"); measure used 0/21, expected-diff abandoned (F4) | all runs; e.g. pi-GOLD-T1B-LBRACKET-r1 final message | 21/21 runs | none on dev | Prompt line: "Verify each positioned feature's measured center against the spec (inspect_part expected diff or printed centers), not by restating your variables." | Closes the position-verification gap before tier-4 (targets H4) |
| F9 | Chamfer/fillet edge selection on feature-cut faces is the recurring struggle: `chamfer(top.edges())` hard-fails on counterbore rims; pocket-rim collateral detected and repaired by reordering; custom perimeter classifier written | pi-GOLD-T3B-DRILLBLOCK-r2-1784834481253, pi-GOLD-T2-POCKET-PLATE-r3-1784833790391, pi-GOLD-T2-POCKET-PLATE-r2-1784833734101 | 3/21 runs | ~2 extra turns per event | Skill line: "Chamfer/fillet edges selected by geometry (`filter_by(GeomType.LINE)`, length/position filters), never `face.edges()` wholesale after cutting features into that face." | Prevents the highest-probability tier-4 failure (H1) |
| F10 | Object-registration juggling: builder registered instead of solid (inspect AttributeError, fixed with `show(p.part,...)`); redundant `b = b2` re-show | pi-GOLD-T2-POCKET-PLATE-r3, pi-GOLD-T3B-DRILLBLOCK-r2 | 2/21 runs | ~2 turns | Prompt line: "Register the solid, not the builder (`show(p.part, ...)`), under one canonical name for the whole session." | Removes stale-object risk in longer tier-4 sessions (H5) |
| F11 | Hidden reasoning is the real cost center on hard geometry: T3 out-tokens are 57% of run cost and 55% of them are reasoning; verbose final recaps duplicate the spec (~150-300 tokens/run) | pi-GOLD-T3-BEARING-HOUSING-r2-1784833946608 (2,486 reasoning tokens in the first message) | structural | ~14% of suite cost is reasoning | Keep as observation (do not cut verification to pay for it); optional micro-trim: "final summary max two lines" | Recap trim alone: ~4-6% cost on B-series runs |

## 3. Robustness margins

Method: recomputed every numeric constraint from `grade.json` measurements against the case tolerances in `benchmarks/golden/v1/cases.json` (154 constraint instances across 21 runs).
Margin = 1 - |delta|/tol, so 0 is at the tolerance edge and 1 is dead center; band checks use distance-to-nearest-edge over half-band.

Headline: the model is parametrically exact - every dimension, radius, position, edge-offset, and center-height delta is 0.0000 mm across all 21 runs.
Margins only exist on derived quantities (volume, face spans), and exactly one constraint sits at the 20% flag line:

| Check | Runs | Margin | Detail |
|---|---|---|---|
| T3 `mount-holes` span + `mount-hole-positions` span | all 3 reps (x2 checks) | **0.20 (flag)** | hole face span 8.0 mm vs band [7,17]; 1.0 mm absolute margin, fully structural (16 mm base minus 8 mm counterbore) |
| T3 `volume-band` | r1/r2/r3 | 0.64 / 0.47 / 0.57 | the only margin that varies across reps: 570,639 / 565,240 / 568,480 mm3 in [550k, 615k]; the spread is interpretation variance (gusset/crown modeling), not noise |
| T2 `corner-fillets` span | all 3 reps | 0.49 | fillet face span 11.1 mm vs band [8, 12.1] (chamfers shorten the vertical fillet face) |
| T3B mount-hole spans | all 3 reps | 0.73 | benign |
| everything else | - | >= 0.86 | dead center |

N>3 flip risks, in order:
1. T3 mount-hole span: not sampling noise (identical all reps) but brittle to modeling style - a counterbore modeled as a builder `CounterBoreHole` or stacked cylinders that split the hole face would push per-face span below the 7 mm floor and fail a geometrically correct part.
2. T3 volume: interpretation variance already spans 5.4k mm3 across 3 reps; a rep that models the crown or gussets differently (e.g. full disc before trim, different gusset triangle) could exit the band low.
3. Dims/volumes are byte-identical across reps for 5/7 cases (T0, T1, T1B, T2B, T3B), so flip risk under N>3 is concentrated entirely in T3-class interpretive parts.

## 4. Latent habits

- Verify after the last mutation: yes in 18/21 runs (inspect_part after the final execute, then render, then export); the 3 exceptions are all T0-BOX, which skipped inspect_part and render_view entirely despite both being prompt-mandated (F6).
- After export: nothing, 21/21.
  The export result itself echoes volume/bbox/faces of the exported model, which is a de facto final check, but the exported STEP file is never independently re-measured, and nothing would catch exporting a stale registered object (see F10).
- Assumptions: never stated, 21/21 (F7), including on genuinely underdetermined geometry (T3 "front face", bearing axis direction) where reps demonstrably diverged.
- render_view skipped: only on tier 0 (3/3 T0 runs); every other run renders exactly once, immediately before export, and no render ever changed anything (F5).
- measure and last_error: never called (0/21 each); inspect_part plus the execute auto-echo is the whole verification diet, and error recovery always proceeds from the error message alone.
- Rep variance: scripts converge to near-identical geometry on 6/7 cases (volume identical to 4 decimals on 5); T3 diverges structurally (bore axis X vs Y, builder vs algebra style), and T2-POCKET diverges in chamfer strategy (edge filter vs custom perimeter classifier vs operation reorder) - i.e. reps diverge exactly where features interact or the frame is underdetermined.
- Style drift between batches: the first batch (T0/T1) stochastically omits the import (5 failures); the B-series batch always leads with `from build123d import *` - the habit is not stable run-to-run.

## 5. Tier-4 failure-mode hypotheses

Each is a prediction for interacting-feature / derived-dimension / multi-axis parts, tied to observed dev-set behavior, and is an intervention target if tier-4 runs confirm it.

- H1 - Edge-selection collateral on interacting features.
  Observed: `chamfer(top.edges())` hard-failed on counterbore rims (T3B r2); chamfer ate the pocket rim and had to be detected and repaired by reordering (T2-POCKET r3).
  Prediction: with more features per face, a non-fatal partial chamfer/fillet will silently drop an inclined-planes or span check.
- H2 - Unstated-assumption coin flips on frames and axes.
  Observed: bearing bore along X (r1/r2) vs Y (r3) on the identical T3 prompt, zero assumption statements.
  Prediction: any tier-4 check that pins an axis, facing, or datum will fail at roughly coin-flip rates per rep.
- H3 - Feature-order dependency breaks derived dimensions.
  Observed: pocket depth read wrong after chamfer interaction until operations were reordered (T2-POCKET r3).
  Prediction: dimensions derived from faces that earlier features moved/consumed (e.g. depth from a chamfered face) will be off by the interacting feature's size and pass local echo checks.
- H4 - Verification granularity stops at bbox/volume/hole-count.
  Observed: claims recite input variables for positions; measure never used; the one tool feature that diffs expected positions (inspect_part `expected`) was schema-fumbled 3x and abandoned (F4/F8).
  Prediction: a hole placed by a wrong derived offset on a tier-4 part will survive verification because nothing numeric ever checks positions.
- H5 - Stale-object export after repair-by-rebuild.
  Observed: builder-vs-solid registration confusion (T2-POCKET r3) and `b = b2` re-show juggling (T3B r2); nothing after export would catch a wrong object.
  Prediction: in longer tier-4 sessions with multiple rebuilds, at least one run will verify or export an object that is not the latest solid.

## 6. Ranked interventions for v1

1. Execute-environment facts block (F1+F2+F3+F10, four sentences): kills 11 of 15 failed tool calls across 9/21 runs, ~-6% suite wall, and removes the turn-count noise that tier-4 sessions cannot afford (F4 fixes 3 more, F9 the last).
2. Conditional single render (F5, one sentence, plus F6's inspect floor): -11.5% suite wall and -6-7% cost with the measured-verification + export floor intact - the largest clean efficiency win available, and together with (1) it covers most of the pre-registered 25% cost/latency fallback bar.
3. Measured-position verification (F4+F8, two sentences: fix the `expected` schema example, require measured centers over recited variables): near-zero dev-set cost, directly targets H4 and H2/H1 adjacent failures, which is where tier-4 correctness will be won or lost.

Honest caveat: interventions 1-2 improve cost/latency on a saturated set; only intervention 3 (plus F7's assumption line and F9's edge-selection line) plausibly moves tier-4 correctness, and none of this is validated until the tier-4 dev runs land.
