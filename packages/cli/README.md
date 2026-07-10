# Chamfer

**Describe it. Watch it take shape.**

Chamfer is an AI CAD designer that runs entirely in your browser. Describe the
part you want in plain words, or show it a photo, and it builds a real 3D model
while you watch — checking its own work from every angle and fixing its
mistakes until the part matches what you asked for. Fine-tune dimensions with
live sliders, then export STEP, STL, or 3MF for 3D printing and manufacturing.

Everything stays on your computer: your API key and your designs never leave
your machine.

## Quick start

```bash
npx chamfer
```

Open the printed URL, add your API key in Settings, and describe a part — or
click one of the preset prompts.

Requires Node.js >= 22.19. The first part you build downloads the CAD kernel
(build123d + OpenCascade via Pyodide, a few tens of MB) into your browser.

## Options

- `--port <n>` — listen on a different port (default 8787)
- `CHAMFER_DATA_DIR` — where conversations and settings are stored
  (default `~/.chamfer`)

## Links

- [Project page](https://smartai.github.io/Chamfer/)
- [Text-to-CAD demo](https://youtu.be/QUC5HnAoHCI) · [Image-to-3D demo](https://youtu.be/n72PvB1WUfw)
- [Source](https://github.com/SmartAI/Chamfer) (Apache-2.0)
