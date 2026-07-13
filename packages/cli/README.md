# Chamfer

**Describe it. Watch it take shape.**

Chamfer turns text and reference images into verified, parametric 3D models.
For complex requests, it creates an evidence-backed plan, executes it over multiple steps, retrieves build123d guidance as needed, and checks both geometry and visual fidelity before finishing.
Fine-tune dimensions with live sliders, then export STEP, STL, 3MF, or Python.

Prompts and attached images are sent to the model provider you configure.
CAD execution, geometry, conversations, and settings stay local.

## Features

- Text and image prompts for reference-guided CAD
- Plan-first execution for long, multi-component builds
- Retrieval-backed build123d docs and progressive skill loading
- Context compaction for reliable long-running sessions
- Multi-view visual self-verification against reference images
- Browser-local build123d execution with kernel-enforced checks

## Quick start

```bash
npx chamfer
```

Open the printed URL, add your API key in Settings, and describe a part, or click one of the preset prompts.

Requires Node.js >= 22.19.
The first part you build downloads the CAD kernel (build123d + OpenCascade via Pyodide, a few tens of MB) into your browser.

## Options

- `--port <n>` - listen on a different port (default 8787)
- `CHAMFER_DATA_DIR` - where conversations and settings are stored (default `~/.chamfer`)

## Links

- [Project page](https://smartai.github.io/Chamfer/)
- [Espresso machine from a product image](https://youtu.be/rvVmGJ5AsDQ)
- [A Text/Image to 3D CAD AI Agent](https://youtu.be/QUC5HnAoHCI)
- [Source](https://github.com/SmartAI/Chamfer) (Apache-2.0)
