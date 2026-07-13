<p align="center">
  <img src="packages/client/public/brand/chamfer-logo.svg" alt="Chamfer" width="474">
</p>

<h3 align="center">Describe it. Watch it take shape.</h3>

<p align="center">
  <a href="https://smartai.github.io/Chamfer/"><b>Project page</b></a> ·
  <a href="https://youtu.be/rvVmGJ5AsDQ">Latest demo</a> ·
  <a href="https://youtu.be/QUC5HnAoHCI">Text-to-CAD demo</a> ·
  <a href="https://youtu.be/n72PvB1WUfw">Image-to-3D demo</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/chamfer"><img src="https://img.shields.io/npm/v/chamfer?color=cb3837&label=npm" alt="chamfer on npm"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="Apache-2.0"></a>
</p>

![The Chamfer workspace: a finished part in the 3D viewer with the conversation that built it](docs/media/hero.png)

## What is Chamfer

Chamfer is an AI CAD designer that turns text and reference images into verified, parametric 3D models.
For complex requests, it creates an evidence-backed plan, executes it over multiple steps, retrieves build123d guidance as needed, and checks both geometry and visual fidelity before finishing.
CAD executes locally in your browser; fine-tune dimensions with live sliders, then export STEP, STL, 3MF, or Python.
Prompts and attached images are sent to the model provider you configure.
CAD execution, geometry, conversations, and settings stay local.

**The finished part, live in the viewer:**

![A stylized amphibious aircraft modeled by Chamfer from a single concept image, rotating in the 3D viewer](docs/media/plane-rotating.gif)

**Latest demo, building an espresso machine from a product image:**

[![Watch the latest Chamfer demo](https://img.youtube.com/vi/rvVmGJ5AsDQ/maxresdefault.jpg)](https://youtu.be/rvVmGJ5AsDQ)

**Text to CAD:**

[![Watch the Chamfer demo](https://img.youtube.com/vi/QUC5HnAoHCI/maxresdefault.jpg)](https://youtu.be/QUC5HnAoHCI)

**Image to 3D, from a single 2D picture:**

[![Watch Chamfer build a part from a 2D image](https://img.youtube.com/vi/n72PvB1WUfw/maxresdefault.jpg)](https://youtu.be/n72PvB1WUfw)

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
