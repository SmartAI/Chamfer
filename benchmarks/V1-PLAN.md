# v1 plan: beat the baseline, honestly

Owner document for the v0 -> v1 iteration. Tracked in-repo so every session (and reader) sees the same
ambition, method, and status. Working branch: `claude/pi-pivot`.

## Definitions

- **v0 (baseline)**: pi-coding-agent + pi-mcp-adapter + build123d-mcp (six direct tools), short generic
  CAD system prompt, no skills, no workflows. This configuration matched Claude Code on correctness and
  beat it ~5x on cost in the 2026-07 benches, so "beat v0" implies "stand out vs generic coding agents".
- **v1**: v0 plus targeted, evidence-backed interventions - instruction/workflow injection only
  (no new code layers, no mediation). Every intervention must trace to a weakness observed in real v0
  run histories on the dev set.

## Method (fixed before any tuning - do not bend)

1. **Dataset split.**
   - DEV set (public, `benchmarks/golden/v1/`): used for v0 evaluation, weakness analysis, and
     intervention design. Analysis may read these transcripts freely.
   - PRIVATE TEST set (git-ignored `benchmarks/private/`, never committed, never read during
     strategy design): used exactly twice - final v0 runs and final v1 runs. No transcript from the
     test set is analyzed until after v1 is frozen. This is the anti-leakage firewall.
2. **v0 evaluation**: N=3 repetitions per dev case, full metrics (correctness via oracle, over-claim,
   cost, tokens, tool calls, latency), committed to `benchmarks/results/`.
3. **Weakness analysis**: read the actual v0 transcripts; catalog failure modes with frequency and
   cost attribution. Candidates from prior benches (to confirm or refute on fresh data): ambiguity
   resolved silently; no re-verification after the last mutation; over-claiming at partial correctness;
   export-contract misses; avoidable retry/exploration turns.
4. **v1 design**: one intervention per confirmed weakness, smallest possible (a sentence over a
   paragraph, a workflow rule over a tool). Each intervention documents: weakness -> change -> expected
   metric movement.
5. **v1 evaluation on DEV** (N=3): iterate until v1 >= v0 on correctness with cost within 1.3x of v0.
6. **Freeze v1**, then run the PRIVATE TEST set: v0 vs v1, N=3 each, same model, sequential.
   Success = v1 beats v0 on test-set correctness without cost blowup. Only then are test transcripts
   readable.
7. Optional reference row: Claude Code + same MCP on the test set (it IS a v0-class arm; expectation:
   v1 > CC on correctness and far cheaper).

## Status log

- 2026-07-23: plan created. Dev-set expansion + runner port in progress (subagents).
  M1 product build (pi backend in packages/server) proceeding in parallel - v1 here is
  prompt/workflow-level and lands on both the CLI arms and the product config.
- 2026-07-23 (later): **v0 saturates the tier 0-3 dev set** - 21/21 perfect runs across 7 cases,
  N=3, zero over-claims, mean cost $0.04-$0.21, latency 15-88 s. Finding #1 of the cycle: with
  unambiguous prompts, the baseline has no correctness headroom at these tiers (and the earlier
  7/9s in the pivot benches are confirmed to have been prompt ambiguity, not capability).
  Method adjustment, pre-registered BEFORE any v1 tuning:
  1. Escalate difficulty: add tier-4 dev cases (and one tier-4 private test case), reference-validated
     like all others, designed around interacting features, derived dimensions, and multi-axis geometry.
  2. Revised success bar: v1 > v0 on test-set correctness including tier 4; if v0 saturates even
     tier-4 test, then v1 must hold correctness while improving cost or latency by >= 25%.
  3. Weakness analysis proceeds on the 21 saturated transcripts for efficiency, robustness margins,
     and latent bad habits (they cannot yield correctness targets by construction).

- 2026-07-23 (freeze): v1 iterated twice on dev and is FROZEN as `arms/v1/` at this commit,
  BEFORE any private-test run. Dev scoreboard (N=3, 9 cases, 243 checks):
  v0 242/243, 1 over-claim, $3.10; v1-draft 242/243, 1 over-claim, $4.22 (open-ended
  self-estimation bloated verification - rejected); v1-final 243/243, 0 over-claims, $3.47,
  wall 1313s (faster than v0). Interventions: execute-environment facts, conditional render
  with a measured-verification floor, single-pass item-by-item reconciliation incl. hole/bore
  diameters and derived dimensions, assumption pinning, no-claim-with-open-discrepancy.
  Next and final step: the one-shot private test - four arms (v0, v1, Claude Code, Codex).

- 2026-07-23 (VERDICT - private test set, first and only read; 5 unseen cases x 3 reps x 4 arms):

  | arm | model | correctness | over-claims | cost | wall |
  |---|---|---|---|---|---|
  | chamfer-v0 | claude-opus-4-8 | 129/129 | 0 | $1.79 | 722 s |
  | chamfer-v1 | claude-opus-4-8 | 129/129 | 0 | $2.16 | 807 s |
  | Claude Code | claude-opus-4-8 | 127/129 | 1 | $10.50 | 2,283 s |
  | Codex | gpt-5.6-luna | 129/129 | 0 | n/a (gateway; 9.5M tokens in) | 1,754 s |

  Honest reading, per the pre-registered bars:
  1. **v1 vs v0: a tie on the test set** (both perfect, both zero over-claims; v1 +21% cost).
     Neither the primary bar (v1 > v0 test correctness) nor the efficiency fallback was met.
     v1's measured benefits exist only on dev tier-4 (243/243 + zero over-claims vs v0's dropped
     check and over-claim there); tiers 0-4 as designed are near-saturated for opus-class agents,
     so the discriminative frontier for future iterations sits ABOVE the current tier-4.
     Decision: v1 ships as the product prompt (its dev-tier-4 honesty gains cost ~nothing and its
     rules encode real failure modes), but we claim NO test-set superiority over v0.
  2. **The horizontal (the business question) is decisive**: both Chamfer arms beat Claude Code on
     unseen tasks - 129/129 vs 127/129 with an over-claim - at ~5-6x lower cost and ~3x lower
     latency; Codex (different model family) matched correctness at 2.4x v0's wall time.
  3. Method integrity held: test set read exactly once, after the freeze commit.

- 2026-07-23 (efficiency probes, both REJECTED on dev - the private test set stays untouched):
  1. **thinking=low (config knob, not agent capability - run only to map the frontier):** T0-T2 hold
     with negligible savings; T1B-LBRACKET degrades to 6/7 on all 3 reps and T3 drops a check.
     Global low thinking trades correctness for <20% cost. Rejected; also confirms the efficiency
     burden must come from capability-class changes (dynamic routing, memory), not knobs.
  2. **v1-eff (pattern card + terse output + complexity-scaled verification):** 236/243, 1 over-claim,
     $3.84, wall 1344s - worse than BOTH v0 ($3.10) and v1 ($3.47) on cost and worse than both on
     correctness. GEARPLATE rep 2 collapsed to 8/15 WITH an over-claim: the "complexity-scaled"
     trimming of verification re-admitted exactly the failure v1's single-pass reconciliation was
     built to kill. Lesson recorded: verification is not overhead to scale away; on interacting-
     feature parts it is the cheapest part of the run.
  3. **Cheaper-model flat swap (claude-sonnet-5):** no data. Both batch attempts aborted in the
     runner's tool warm-up (the warm-up validates the six b123 tools by observing calls; sonnet did
     not exercise all six, so the harness refused to start timed runs). A harness limitation, not
     evidence about the model.

- 2026-07-24 (consolidation - decision by Min): STOP ad-hoc efficiency probing. The one-knob-at-a-time
  probes (thinking level, model swap, prompt-compression arm) were drifting toward configuration
  tuning and away from agent capability, and risked over-complicating v1. Standing conclusion:
  **v1 as frozen and merged is the best known configuration**; zero efficiency interventions were
  accepted (thinking-low rejected on correctness, v1-eff rejected on correctness AND cost, model swap
  unmeasured). Any future efficiency or capability work (memory across tasks, routing) starts with a
  comprehensive analysis phase and a pre-registered evaluation design - including tasks hard enough
  to discriminate (above current tier-4) and campaign-mode metrics for memory - before any strategy
  is implemented.

## Deliverables

- `benchmarks/results/` rows for: v0-dev (N=3), v1-dev iterations, v0-test, v1-test (+ CC-test if run).
- Weakness analysis: `benchmarks/analysis/v0-weaknesses.md` (dev-set evidence only).
- v1 definition: `benchmarks/arms/v1/` (system prompt + any workflow injection, fully reproducible).
- Post-v1: public write-up of the whole evaluation-driven journey (baseline humility, golden sets,
  what beat what, lessons) - drafted only after test-set numbers are in.
