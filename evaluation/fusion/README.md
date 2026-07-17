# Fusion evaluation

The versioned corpus in `v1/corpus.json` is the canonical task contract for the three Fusion tracer fixtures. The reviewed ten-case slices are pinned separately: `v1/foundational.json` (foundational parametric-part cases) and `v1/multimodal-manual.json` (multimodal and manual-revision cases). Keeping slices separate preserves the original tracer cohort identity and lets later additions remain exactly ten cases apiece while all slices use the same runner and attempt contract.

Every multimodal case pins a reviewed synthetic contract and one or more SVG reference assets by SHA-256. That slice covers orthographic and complementary views, scoped text overrides, incomplete evidence, supersession, three manual edits, two topology changes, explicit ownership transfer, and focused escalation. Its semantic rubric deliberately scores design intent, editability, and visual quality separately from deterministic geometry and integrity checks.

Generated attempts, runtime databases, browser traces, screenshots, and reports belong under the ignored `docs/internal/fusion-evaluation/` directory.

The ten-case ticket slices are separate versioned corpora so each ticket keeps an exact, reviewable case count while using the same loader, runner, evaluator, and artifact contracts. The industrial and failure-recovery slice is `v1/industrial-recovery.json`; its shared human-readable requirements are hash-pinned in `v1/industrial-recovery-contracts.md`.

Run the production-browser path with the scripted model and protocol-faithful fake Fusion endpoint:

```bash
npm run fusion:evaluate -- run --mode scripted --trials 1
```

Select a ticket slice with `--corpus`, for example:

```bash
npm run fusion:evaluate -- run --mode live --provider <provider> --model <model> --trials 5 \
  --corpus evaluation/fusion/v1/industrial-recovery.json
```

Fault-injection cases require an evaluation adapter that applies the declared `faultInjection` only at its pinned trigger. A live run must not reinterpret these declarations as instructions for the model.

Validate and materialize the complete repeated-trial schedule without claiming that any modeling attempt ran:

```bash
npm run fusion:evaluate -- plan --trials 5 \
  --corpus evaluation/fusion/v1/industrial-recovery.json \
  --out docs/internal/fusion-evaluation/industrial-recovery-plan
```

The generated `plan.json` and `plan.md` pin every case identity, trial number, embedded typed-effect count, fault, and attack vector. Attempt and cohort artifacts remain separate and are created only by real runner executions or ingested Autodesk trials.

Scripted results prove runner and evaluator integrity only. They are excluded from proficiency denominators.

Run a repeated live-model cohort against the fake connector:

```bash
npm run fusion:evaluate -- run --mode live --provider <provider> --model <model> --trials 5
```

Run either ten-case slice by selecting its pinned corpus:

```bash
npm run fusion:evaluate -- run --corpus evaluation/fusion/v1/foundational.json \
  --mode live --provider <provider> --model <model> --trials 5
npm run fusion:evaluate -- run --corpus evaluation/fusion/v1/multimodal-manual.json \
  --mode live --provider <provider> --model <model> --trials 5
```

Each foundational case pins its reviewed Markdown contract and carries its dimensions and tolerances, native feature intent, trusted typed effects, required evidence, forbidden outcomes, stable difficulty basis, and interaction budget directly through the runner contract. Completed cases can therefore be inspected without adding a case ID to the browser runner. Scripted fake-model coverage remains limited to the three tracer fixtures; use live mode for foundational proficiency trials.

A deterministic live attempt is emitted successfully with semantic review marked pending. It is a usable repeated-trial artifact, but remains incomplete and excluded from proficiency until blinded review scores are ingested. Infrastructure failures, integrity failures, missing evidence, and other incomplete attempts still fail the runner.

For a prepared disposable live Fusion document, additionally pass a strict loopback endpoint, a matching release-integrity report, the exact disposable document ID, and the observed Fusion/MCP versions. External runs intentionally accept one case and one trial per invocation so each attempt starts from a freshly prepared disposable document. Reuse the cohort ID and output directory while advancing `--trial-start`:

```bash
npm run fusion:evaluate -- run --mode live --provider <provider> --model <model> --trials 1 \
  --cases FUS-TEXT-001 --cohort <cohort-id> --trial-start 1 --out <private-output> \
  --endpoint http://127.0.0.1:27182/mcp \
  --integrity-report docs/internal/fusion-release-integrity.json \
  --disposable-document-id <document-id> \
  --fusion-version <version> --mcp-name <name> --mcp-version <version> --mcp-protocol <version>
```

Prepare a new disposable document, then repeat with `--trial-start 2`, and so on. The runner accumulates attempts in the same private output directory. It refuses an unpinned document, a non-loopback endpoint, or multiple external attempts without an intervening setup opportunity. Manual-edit cases need an explicit setup adapter before they can run against a real Fusion instance.

Autodesk Assistant trials use the same attempt schema with `participant: "autodesk-assistant"`, `executionMode: "ingested"`, and the case's exact `pairedCaseIdentity`. Ingest and compare them with:

```bash
npm run fusion:evaluate -- ingest-autodesk --input <attempt-json-or-directory> --out <private-output>
npm run fusion:evaluate -- compare --chamfer <attempt-directory> --autodesk <attempt-directory> --trials 5
```

Comparison fails closed on incomplete trials, mismatched case/input/budget identity, mixed cohort pins, unavailable deterministic evaluation, and integrity failures. Semantic review remains blinded and separate. Efficiency is reported only when both paired outcomes are successful.

## Autodesk Assistant superiority release gate

`v1/release-corpus.json` is the authoritative 33-case release corpus. It hash-pins the three tracer fixtures plus the foundational, multimodal/manual, and industrial/recovery slices. Generate its five-trial paired schedule before collecting release evidence:

```bash
npm run fusion:evaluate -- plan --trials 5 \
  --corpus evaluation/fusion/v1/release-corpus.json \
  --out docs/internal/fusion-evaluation/release-plan
```

The schedule alternates Chamfer and Autodesk Assistant inside every case/trial pair. Run against equivalent freshly prepared Fusion conditions in that order. Every attempt must retain the exact case identity, interaction budget, environment, versions, timestamps, blinded semantic scores, and deterministic evidence already required by the attempt schema.

Prepare a private metadata JSON with the comparison timestamp, blinded-review agreement, tested scope, and at least one explicit limitation:

```json
{
  "comparisonDate": "2026-07-15T20:00:00.000Z",
  "reviewerAgreement": {
    "humanReviewConfirmed": true,
    "reviewCohortId": "fusion-blinded-review-2026-07-15",
    "reviewProtocolVersion": "fusion-quality-v1",
    "assignmentsSha256": "<sha256-of-pinned-reviewer-assignments>",
    "reviewedScoresSha256": "<buildFusionReviewedScoresIdentity output>",
    "method": "Krippendorff alpha",
    "value": 0.82,
    "reviewerCount": 3
  },
  "scope": "parametric single-part Fusion tasks",
  "limitations": ["Does not cover assemblies, drawings, or manufacturing workflows."]
}
```

Then issue the reproducible release verdict:

```bash
npm run fusion:evaluate -- gate --trials 5 \
  --chamfer <chamfer-attempt-directory> \
  --autodesk <autodesk-attempt-directory> \
  --metadata <private-metadata.json> \
  --out docs/internal/fusion-evaluation/release-verdict
```

The human-review fields attest that the review was performed by people, pin the blinded assignment artifact, and bind the agreement statistic to the exact attempt-score set. Compute `reviewedScoresSha256` over both parsed cohorts with:

```bash
npm run fusion:evaluate -- review-identity \
  --chamfer <chamfer-attempt-directory> \
  --autodesk <autodesk-attempt-directory>
```

The command exits nonzero and emits `claim-blocked` unless all 33 cases are complete, every adjacent Chamfer/Autodesk case-trial pair starts within 24 hours, the pinned human-review score identity matches, Chamfer has no integrity failures, its full-task pass advantage is at least 20 percentage points, the deterministic paired bootstrap interval is above zero, and blinded design-intent, editability, and visual-quality means are no worse. The JSON and Markdown verdicts expose raw per-case outcomes, failure classes, confidence method and seed, reviewer agreement, pinned versions, date, scope, and limitations. Public comparison language remains unauthorized unless the verdict is `claim-authorized`.
