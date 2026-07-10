# Verify Gate — Implementation Notes

Companion to `2026-07-10-verify-gate-design.md`.

## Deviations

1. **`is_valid` is a property, not a method** — the spec (and first implementation)
   assumed `shape.is_valid()`; in build123d 0.11.1 it is a `bool` property. The
   fail-open path caught this exactly as designed (gate reported `status: "error"`
   while the run stayed healthy) — an accidental live validation of the fail-open
   contract before the fix.

2. **Gate verdict added to the tool-call card UI** — the spec only required the
   verdict in the tool-result *text* (agent-facing) and an e2e that a failure is
   "visibly reported". The card renders measurements but never the result text on
   success, so the verdict would have been invisible to the user. Added `gate` to
   the tool result `details` (persisted verbatim in `contentJson`, so it replays)
   and a `tool-gate` row on `ToolCallCard`: status line always, failing checks
   listed only on failure.

3. **Fake-LLM gate-fail scenario keyed on transcript text** — `fakeLlm` branches on
   the literal `gate-fail` appearing anywhere in the serialized messages. Crude but
   deterministic, matches the existing fake's style, and needs no protocol change.

## Environment notes (not code changes)

- Git worktrees don't get their own `node_modules`; Node resolution walks up to the
  main checkout's, whose `@chamfer/shared` symlink points at the *main* copy —
  typecheck saw stale types while vitest (runtime) passed. `npm ci` inside the
  worktree fixes it. Worth remembering for any worktree-based session on this repo.
- py-tests need a venv with `build123d==0.11.1` + `pytest` (none existed on this
  machine; created a throwaway one in the session scratchpad).

## Measurements

- Gate overhead: ~1.5 ms per run vs ~43 ms for the bracket fixture's full
  run_script (~3%); dominated by `is_valid`. No perf budget concern.
