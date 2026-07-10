# Verification Trust UI (Approaches A + B) — Design

Date: 2026-07-10
Status: approved (mockup review: https://claude.ai/code/artifact/761a4f69-6d99-4b89-8cd6-7444264d91da,
"ship A + B together" recommendation accepted)
Depends on: verify gate (merged, PR #2)

## Problem

The verify gate produces per-run evidence (named checks, diagnostics, verdict) but the UI
shows only a terse row on the tool card. Users can't tell at a glance which conversations
produced verified parts, whether the current session's model is verified, or what the
agent actually checked — the trust the gate earns is invisible.

## Scope

Two composing pieces, both pure presentation of already-persisted data plus one small
server rollup. Approaches C (evidence timeline) and D (viewer HUD seal) are explicitly
deferred (C until Part-A eval evidence exists; D until the gate is validated).

**Copy rule (hard):** the UI always says what was checked — "5/5 declared checks" —
never "correct" or "matches your request". The gate verifies the agent's plan, not the
user's intent.

## B — Verification receipt (ToolCallCard)

Replace the minimal gate row with a receipt block (same `tool-gate` testid):

- Header: status dot + "Verification" + check count.
- One row per check — pass/fail icon, check name, full diagnostic detail (mono). All
  checks are listed, not only failures: showing the work is the point.
- Footer verdict bar: `GATE PASSED — all declared expectations met` /
  `GATE FAILED — N of M checks failed` / `Verification unavailable — evaluator error;
  inspect the views manually`.
- Ticks fade in staggered (~120 ms apart) via CSS animation; disabled under
  `prefers-reduced-motion`. Animation is mount-time CSS only — no JS timers.
- Absent gate (pre-gate history, older worker): no receipt, unchanged rendering.

## A — Ambient status (chips + dots)

### Chat header chip
ChatPanel gains a slim header strip (conversation title + chip) when a conversation is
active. Chip state, derived client-side from `sessionState.messages`:

1. `sessionState.streaming` → amber "Verifying…" (pulse dot).
2. Else, latest `toolResult` carrying `details.gate` → green "Verified · n/n checks"
   (status `passed`) or red "Gate failed" (`failed`/`error` counts as not verified;
   `error` renders gray "Unverified").
3. No gate-bearing result → no chip.

Derivation lives in a pure helper `latestGateSummary(messages)` (own module,
unit-tested), not inline in the component.

### Sidebar conversation dots
The sidebar renders a status dot per conversation (green `passed` / red `failed` or
`error` / none). The sidebar doesn't load messages, so the verdict is rolled up
server-side:

- `conversations.last_gate_status TEXT` column; additive migration in `openDb`
  (`ALTER TABLE … ADD COLUMN`, tolerated if the column already exists).
- `createMessage`: when `role === "toolResult"` and the parsed `contentJson` has
  `details.gate.status` ∈ {passed, failed, error}, update the conversation's
  `last_gate_status`. Malformed JSON or absent gate → no-op (never blocks the insert).
- `ConversationDto.lastGateStatus?: "passed" | "failed" | "error"`.
- Client refreshes the conversation list when a turn finishes (existing refresh path
  after title generation already refetches; reuse/extend it) so dots update without a
  reload.

## Error handling

- Rollup extraction is wrapped: a parse failure can never fail message persistence.
- Chip/dot for `error` gates deliberately reads as "not verified", never as failure of
  the *part* — matching the fail-open semantics of the gate itself.

## Testing

- Server: `conversationStore` tests — rollup set on gate-bearing toolResult, untouched
  otherwise, malformed JSON tolerated, migration idempotent on a pre-existing DB file.
- Client: `latestGateSummary` unit tests (verified / failed / error / none / order);
  ToolCallCard receipt states (pass, fail, unavailable, absent); ChatPanel header chip;
  Sidebar dot rendering.
- E2E: happy path asserts header chip "Verified" and green sidebar dot; gate-fail
  scenario asserts red chip, red dot, and failing receipt rows.

## Build order

1. Server rollup + DTO (tests first).
2. `latestGateSummary` + header chip + sidebar dots.
3. Receipt upgrade in ToolCallCard.
4. E2E extensions, full suite, ship.
