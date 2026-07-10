<p align="center">
  <img src="packages/client/public/brand/chamfer-logo.svg" alt="Chamfer" width="474">
</p>

<h3 align="center">Describe it. Watch it take shape.</h3>

<p align="center">
  <a href="https://smartai.github.io/Chamfer/"><b>Project page</b></a> ·
  <a href="https://youtu.be/QUC5HnAoHCI">Text-to-CAD demo</a> ·
  <a href="https://youtu.be/n72PvB1WUfw">Image-to-3D demo</a>
</p>

![The Chamfer workspace: a finished part in the 3D viewer with the conversation that built it](docs/media/hero.png)

## What is Chamfer

Chamfer is an AI CAD designer that runs entirely in your browser.
Describe the part you want in plain words, or show it a photo, and it builds a real 3D model while you watch, checking its own work from every angle and fixing its mistakes until the part matches what you asked for.
Fine-tune dimensions with live sliders, then export STEP, STL, or 3MF for 3D printing and manufacturing.
Everything stays on your computer.

**Text to CAD:**

[![Watch the Chamfer demo](https://img.youtube.com/vi/QUC5HnAoHCI/maxresdefault.jpg)](https://youtu.be/QUC5HnAoHCI)

**Image to 3D, from a single 2D picture:**

[![Watch Chamfer build a part from a 2D image](https://img.youtube.com/vi/n72PvB1WUfw/maxresdefault.jpg)](https://youtu.be/n72PvB1WUfw)

## Features

- AI generation from text or an image
- Real-time 3D preview with live sliders to review and adjust
- Multiple export formats: STEP, STL, 3MF, and the Python script
- Runs locally: your key and your designs never leave your machine

## How to use it

Requires Node.js >= 22.19.

```bash
npm install
npm run dev
```

Open the printed URL, add your API key in Settings, and describe a part or click one of the preset prompts.

## License

Apache-2.0 ([LICENSE](LICENSE)).
[NOTICE](NOTICE) covers the bundled runtime components.
