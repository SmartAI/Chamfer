# Chamfer

**Describe it. Watch it take shape.**

Chamfer turns a sentence or a reference image into a real, parametric 3D model you can inspect and export.
It writes build123d Python, runs it on a real geometry kernel, and measures what it built - dimensions, holes, body count - against your request before showing it to you.

Try it without installing anything at [chamferonline.com](https://chamferonline.com).

## Demos

### Espresso machine from a product image

[![Watch the espresso machine demo](https://img.youtube.com/vi/rvVmGJ5AsDQ/hqdefault.jpg)](https://youtu.be/rvVmGJ5AsDQ)

### A Text/Image to 3D CAD AI Agent

[![Watch the Text/Image to 3D CAD demo](https://img.youtube.com/vi/QUC5HnAoHCI/hqdefault.jpg)](https://youtu.be/QUC5HnAoHCI)

## Features

- Two CAD backends, picked per conversation: local build123d, or your live Autodesk Fusion session (auto-detected, no port to configure)
- Text and image prompts for reference-guided CAD
- Kernel-verified output: measured and visually inspected against the request before the agent finishes
- Anthropic, OpenAI, or Google models - bring your own key
- STL, OBJ, and GLB export from the viewer

## Quick start

```bash
npx chamfer
```

Open the printed URL, add your API key in Settings, and describe a part, or click one of the preset prompts.

Requires Node.js >= 22.19 and [uv](https://docs.astral.sh/uv/), which Chamfer uses to spawn the pinned `build123d-mcp` CAD server.
The first build downloads that server and its CAD kernel, so it takes noticeably longer than the ones after it.

## Options

- `--port <n>` - listen on a different port (default 8787)
- `CHAMFER_DATA_DIR` - where conversations and settings are stored (default `~/.chamfer`)

## Links

- [Project page](https://smartai.github.io/Chamfer/)
- [Source](https://github.com/SmartAI/Chamfer) (Apache-2.0)
