# Hosted agent container image (issue #47, ADR 0003): the unmodified
# benchmarked agent slice - packages/server's pi-coding-agent session host plus
# build123d-mcp over uv - behind the small HTTP surface in
# packages/server/src/container/. Stateless by contract: CHAMFER_DATA_DIR is
# scratch, the transcript and artifact leave through the HTTP seams by turn
# end, and the image accepts no LLM provider keys (egress is exclusively
# CHAMFER_LLM_BASE_URL + CHAMFER_LLM_TOKEN).
#
# Build context is this directory; run `node build.mjs` first to stage
# dist/server.mjs and dist/patches (smoke.mjs orchestrates both). The
# Dockerfile is arch-agnostic: pass --platform linux/amd64 for deployment
# builds, omit it for host-native local smoke runs.
#
# Base image per pi's reference Dockerfile.pi (docs/containerization.md).
# Deviation from its apt set, measured against our config: bash/git/ripgrep
# back pi's builtin tools, but this agent runs noTools:"builtin" (MCP direct
# tools only), so they are omitted. The libgl/libx11 group is what OCP's
# OCCT wheels link against on linux. libosmesa6 gives VTK a software OpenGL
# backend: with no X server, no EGL, and no OSMesa in the image, VTK's render
# window hard-aborts the MCP worker on every render_view (the "worker crashed
# during 'render_view'" replay loop); warmup.mjs gates the image on this.
FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    fontconfig \
    libgl1 \
    libglu1-mesa \
    libosmesa6 \
    libxrender1 \
    libxext6 \
  && rm -rf /var/lib/apt/lists/*

# uv from the official distroless image; multi-arch, version pinned to the
# line the local dev machines run.
COPY --from=ghcr.io/astral-sh/uv:0.11.2 /uv /uvx /usr/local/bin/

WORKDIR /app

# Runtime npm deps (exact pins) + the repo's patch-package patches, so the
# image runs byte-identical pi packages to the benchmarked workspace.
COPY runtime-package.json package.json
COPY dist/patches ./patches
RUN npm install --omit=dev --ignore-scripts \
  && npm exec patch-package -- --error-on-fail \
  && npm cache clean --force

# Bake the CAD Python environment at build time: warmup runs the EXACT spawn
# from mcpTools.ts (uv tool run --python 3.12 build123d-mcp==0.3.79), executes
# a real build123d snippet, then re-runs it with UV_OFFLINE=1 to prove the
# first user turn needs no network for the CAD stack. This layer sits before
# the server bundle so agent-code changes rebuild in seconds without
# re-downloading the CAD stack.
COPY warmup.mjs ./warmup.mjs
RUN node ./warmup.mjs && rm ./warmup.mjs

# The bundled server entry (esbuild output of packages/server/src/container/entry.ts).
COPY dist/server.mjs ./server.mjs

# UV_OFFLINE turns the no-download-at-first-turn contract into an enforced
# invariant: an incompletely baked cache fails loudly instead of downloading.
ENV UV_OFFLINE=1 \
  CHAMFER_DATA_DIR=/data \
  PORT=8787 \
  NODE_ENV=production

EXPOSE 8787
CMD ["node", "/app/server.mjs"]
