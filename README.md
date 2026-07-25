# Chamfer

**Describe it. Watch it take shape.**

[Try it online](https://chamferonline.com) · [npm](https://www.npmjs.com/package/chamfer) · [Apache-2.0](LICENSE)

## What is Chamfer

Chamfer is an AI CAD designer that turns text and reference images into verified, parametric 3D models.
For complex requests, it creates an evidence-backed plan, executes it over multiple steps, retrieves build123d guidance as needed, and checks both geometry and visual fidelity before finishing.
CAD executes locally in your browser; fine-tune dimensions with live sliders, then export STEP, STL, 3MF, or Python.
Prompts and attached images are sent to the model provider you configure. For Autodesk Fusion conversations, Chamfer also sends only selected normalized evidence from the bound design: necessary engineering snapshot fields, relevant installed API excerpts, selected views, and normalized action results.
CAD execution, native geometry and Fusion files, unrelated documents and projects, credentials, raw MCP traffic, conversations, and settings stay local.

## Demos

### Driving Autodesk Fusion autonomously

<a href="https://chamferonline.com/media/fusion-demo-0716.mp4"><img src="https://chamferonline.com/media/fusion-demo-0716-poster.jpg" alt="Watch Chamfer drive Autodesk Fusion: a finned motor bearing housing built and visually verified from one prompt" width="480" /></a>

### Espresso machine from a product image

[![Watch the espresso machine demo](https://img.youtube.com/vi/rvVmGJ5AsDQ/hqdefault.jpg)](https://youtu.be/rvVmGJ5AsDQ)

### A Text/Image to 3D CAD AI Agent

[![Watch the Text/Image to 3D CAD demo](https://img.youtube.com/vi/QUC5HnAoHCI/hqdefault.jpg)](https://youtu.be/QUC5HnAoHCI)

## Features

- Text and image prompts for reference-guided CAD
- Plan-first execution for long, multi-component builds
- Retrieval-backed build123d docs and progressive skill loading
- Context compaction for reliable long-running sessions
- Multi-view visual self-verification against reference images
- Browser-local build123d execution with kernel-enforced checks
- Live parametric sliders and STEP, STL, 3MF, or Python export

## How it compares to other coding agents

The same models that power Chamfer (Claude, GPT, Gemini) can already drive a CAD MCP server on their own, so the honest question is whether a purpose-built harness earns its place.
We measured it rather than asserting it.
On a held-out set of mechanical CAD parts, Chamfer, Claude Code, and Codex each received the identical prompts and the identical build123d MCP server, and every exported STEP file was graded by a geometry-kernel oracle - never by the agent's own claim of success.

Chamfer built the same correct parts as the generic agents, with far fewer tokens, fewer tool calls, and less money and time to get there:

| Agent | Correctness | Tool calls / task | Context read / task | Output / task | Cost | Wall time |
|---|---|---|---|---|---|---|
| **Chamfer v0** | 129/129 | 6.3 | ~53k | 2,232 | **$1.79** | **722 s** |
| **Chamfer v1** (default) | 129/129 | 5.0 | ~48k | 3,087 | $2.16 | 807 s |
| Claude Code | 127/129 ¹ | 8.2 | ~433k | 9,849 | $10.50 | 2,283 s |
| Codex ² | 129/129 | 15.5 | ~1,169k | 4,617 | n/a | 1,754 s |

5 held-out parts, 3 runs each (15 runs per agent).
Chamfer and Claude Code ran the same model (`claude-opus-4-8`); Codex ran `gpt-5.6-luna`.
Tool calls, context, and output are per-task means; cost and wall time are totals over the 15 runs.
That is **5.9x lower cost** and **3.2x lower wall time** than Claude Code for the same or better result, and 2.4x lower wall time than Codex - with zero over-claims (Chamfer never reported a part as done while a check was failing; Claude Code did once).

The gap is not the model (Claude Code ran the identical one) and not the CAD server (identical binary for every arm) - it is the harness around the model:

- **Purpose-scoped context.** Chamfer carries a one-screen CAD prompt and six curated tools; Claude Code carried 59 tool schemas plus general-purpose scaffolding into every turn. That is the ~8x difference in context read, and context is what you pay for.
- **A verification contract, not verification wandering.** Chamfer measures once and reconciles every requested dimension, hole, and diameter against the request in a single pass, then stops - instead of looping through repeated self-checks.
- **Terse output.** Output tokens are the expensive, latency-dominating ones; Chamfer emits ~4x fewer than Claude Code, which is most of the wall-clock gap.

Full methodology, the side-by-side artifact gallery, and every reproducible run summary live in [`benchmarks/`](benchmarks/) - start with the [benchmark report](benchmarks/REPORT.md).

¹ One slotted-plate run split cylindrical faces in the exported B-rep in a way the current oracle does not re-merge; the geometry looks correct on inspection, so read this as "at least 127/129." That same run is the single over-claim. The cost and time gaps are unaffected.
² Codex ran through a proxy that does not report billing, so its cost is not comparable and its row supports the latency comparison only; it read ~22x Chamfer's context to do it.

## How to use it

The fastest way is the hosted app at **[chamferonline.com](https://chamferonline.com)** - sign in with Google and start designing in your browser, no install. build123d runs client-side; the Autodesk Fusion connector is local-only, so use the CLI below for that.

To run it yourself (requires Node.js >= 22.19):

```bash
npx chamfer
```

Open the printed URL, add your API key in Settings, and describe a part or click one of the preset prompts.
Your conversations and settings live in `~/.chamfer`.

### Configuration

Instead of typing keys into Settings, you can put them in a `.env` or `.env.local` file in the directory you run `chamfer` from.
See [.env.example](.env.example) for every supported variable (provider API keys, base URLs, default model, port, data dir) with explanations.
Values found in the environment appear pre-filled in Settings with a `.env` badge; anything you change there overrides the environment and can be reverted with "Reset to .env".

### Developing

```bash
npm install
npm run dev
```

Agent configuration changes are checked against the incumbent with a deterministic two-fixture smoke tier.
Run the same gate locally with one command, using the intended merge base:

```bash
npm run eval:smoke -- --base=origin/main
```

The command writes the scorecard under `.agent/evaluations/` and updates the tracked configuration probe pin after a passing comparison.
Commit that pin with the configuration change.

A deliberately accepted regression requires one JSON waiver added or modified under `.github/agent-bench-waivers/` in the same change.
The waiver must bind to the candidate runtime configuration hash, name every regressed pillar, and explain both what regressed and why it is accepted:

```json
{
  "schemaVersion": 1,
  "candidateConfigurationHash": "64-character SHA-256 hash from the failing scorecard",
  "regressedPillars": ["taskSuccess"],
  "regression": "Describe the measured regression in at least 20 characters.",
  "reason": "Explain why maintainers deliberately accept it in at least 20 characters."
}
```

CI accepts only a waiver changed by that pull request and reports the result as a warning instead of silently passing it.

The deterministic full tier covers every versioned evaluation fixture and runs on demand rather than on every pull request:

```bash
npm run eval:full -- --configuration=current
```

Add `--incumbent=<configuration>` plus `--incumbent-root=<worktree>` when a paired scorecard diff is required.
The release workflow runs that paired full tier against the preceding accepted release before publishing.

The fixture-set version and content hash are pinned in `packages/client/eval/golden/agent-configuration-full-v1.scorecards.json`.
Any fixture JSON or asset change must increment the version in `packages/client/eval/fixtureSet.ts`, then regenerate the expected scorecards in the same change:

```bash
npm run eval:full:update-golden
```

The test suite fails with this regeneration command when the checked-in pin is stale.
Run `npm run eval:full:test` to repeat the real fake-LLM full-tier determinism and identity meta-test against the pin.

## License

Apache-2.0 ([LICENSE](LICENSE)).
[NOTICE](NOTICE) covers the bundled runtime components.
