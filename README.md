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

## Benchmarks

Chamfer's agent is measured, not asserted.
On a held-out set of mechanical CAD tasks, it produced the same correct parts as Claude Code and Codex driving the same CAD server, at roughly 1/6 of Claude Code's cost and 1/3 of its wall-clock time, with zero over-claims.
The full methodology, the four-agent head-to-head, and the reproducible run summaries live in [`benchmarks/`](benchmarks/) - start with the [benchmark report](benchmarks/REPORT.md) if you want to see the evidence.

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
