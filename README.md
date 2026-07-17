# Chamfer

**Describe it. Watch it take shape.**

[Project page](https://smartai.github.io/Chamfer/) · [npm](https://www.npmjs.com/package/chamfer) · [Apache-2.0](LICENSE)

## What is Chamfer

Chamfer is an AI CAD designer that turns text and reference images into verified, parametric 3D models.
For complex requests, it creates an evidence-backed plan, executes it over multiple steps, retrieves build123d guidance as needed, and checks both geometry and visual fidelity before finishing.
CAD executes locally in your browser; fine-tune dimensions with live sliders, then export STEP, STL, 3MF, or Python.
Prompts and attached images are sent to the model provider you configure. For Autodesk Fusion conversations, Chamfer also sends only selected normalized evidence from the bound design: necessary engineering snapshot fields, relevant installed API excerpts, selected views, and normalized action results.
CAD execution, native geometry and Fusion files, unrelated documents and projects, credentials, raw MCP traffic, conversations, and settings stay local.

## Demos

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

## How to use it

Requires Node.js >= 22.19.

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

## License

Apache-2.0 ([LICENSE](LICENSE)).
[NOTICE](NOTICE) covers the bundled runtime components.
