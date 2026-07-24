# Chamfer agent guide

## Agent skills

### Issue tracker

Issues and specs are tracked as GitHub issues on the private development repo (`origin`).
See `docs/agents/issue-tracker.md`.

### Triage labels

Triage uses the five canonical role strings.
See `docs/agents/triage-labels.md`.

### Domain docs

Chamfer uses a single-context domain layout.
See `docs/agents/domain.md`.

Chamfer is an AI CAD designer used through the browser.
The agent is a server-hosted [pi-coding-agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) session (one per conversation) that writes [build123d](https://build123d.readthedocs.io/) Python and executes it through the `build123d-mcp` MCP server on real CPython; the geometry kernel verifies results before the user sees them.
The browser is a thin terminal: it POSTs prompts, renders the SSE event stream, and loads the exported `artifact.stl` into the viewer.
Node >= 22.19 and `uv` (spawns the pinned `build123d-mcp`) are required.

## Repo layout

npm workspaces monorepo:

- `packages/shared` - protocol types and DTOs shared by client and server (`src/index.ts`).
- `packages/client` - React 19 + Vite app: `src/api/` (POST message / SSE events / artifact fetch transport), `src/components/` chat UI, `src/viewer/` three.js viewer, `src/state/` app state.
- `packages/server` - the Hono server that hosts the agent:
  - `src/agent/` - one pi-coding-agent `AgentSession` per conversation (`piSession.ts`), turn transcript persistence (`turnPersistence.ts`), the artifact store seam (`artifactStore.ts`), MCP wiring (`mcpTools.ts`: pi-mcp-adapter spawns the pinned `build123d-mcp` via `uv`, or connects the loopback Fusion adapter), and the system prompts (`prompts.ts`).
  - Conversation/settings stores (SQLite), `.env` loading, and the loopback Autodesk Fusion connector.
- `packages/cli` - the publishable `chamfer` npm package; esbuild bundles server + built client into `dist/`.
- `packages/online` - the Cloudflare Workers deployment (chamferonline.com): better-auth in front, the server's route modules inside a per-user SQLite Durable Object, demo-key token budgets. Agent hosting is currently off there (`agentHosting: false`); the restoration plan is ADR 0003 (per-user Cloudflare Containers), tracked by #40. See its README.md.
- `benchmarks/` - the golden dataset, measurement oracle, and cross-agent runners that gate agent changes.

`docs/internal/` is git-ignored and holds local working notes. Never commit anything into it or move its contents into tracked paths; this repo is public.

## Design and implementation rules

- **Read the pi packages before designing anything agent-related.**
  The agent is `@earendil-works/pi-coding-agent` driven through its SDK, built on `@earendil-works/pi-agent-core` (agent/session/tool abstractions) and `@earendil-works/pi-ai` (provider-agnostic LLM streaming).
  All ship extensive READMEs and typings in `node_modules/@earendil-works/*/`; read them first.
  Most "missing" capabilities (retries, sessions, compaction, tool wiring, event streams, message shapes) already exist there, and a design that fights their abstractions will be rejected.
  The point of the M1 pivot (issue #33) was to run the benchmarked agent unmodified; do not add mediation layers on top of it without benchmarked value.
- **Do not reinvent wheels.**
  Before designing or implementing any non-trivial capability, search for an existing well-maintained package (npm for TS, PyPI for the harness) and prefer it over a hand-rolled version.
  Only build in-house when nothing popular fits or the dependency cost is clearly worse than owning the code, and say so explicitly in the design.

## Commands

```bash
npm install
npm run dev          # client on 5173, server on 8787
npm run typecheck    # all workspaces
npm test             # vitest, all workspaces
npm run build        # shared -> client -> server -> cli
npm run e2e          # Playwright, see below
```

### py-tests (orphaned)

`py-tests/` tested the pre-pivot in-browser Pyodide harness, which the M1 pivot deleted; the suite imports a module that no longer exists and cannot run.
Do not extend it; its removal (or repurposing against `build123d-mcp`) is tracked under #40.
The build123d regression knowledge it encoded (e.g. `intersect()`/`Hole` semantics) lives on in the Gotchas below and in `benchmarks/`.

### E2E (Playwright)

- Runs its own dev stack on ports 5273 (client) / 8887 (API) so it does not collide with a live `npm run dev`.
- The suite is intentionally lean post-pivot: `app-boot.spec.ts` is the remaining spec; new specs need a scripted fake LLM and a scratch database:

  ```bash
  CHAMFER_FAKE_LLM=1 CHAMFER_DATA_DIR=$(mktemp -d) npm run e2e
  ```

- Both web servers use `reuseExistingServer: false`, so a busy port aborts the run loudly ("... is already used") instead of silently reusing a stale server.
- Trap: those ports may be owned by a **concurrent session's live e2e run**, not a stale leftover.
  Never blindly kill listeners on 5273/8887 - killing a live sibling stack mid-run makes its specs fail in bizarre ways.
  Prefer private ports for your own run via `CLIENT_PORT` / `PORT`; only kill a listener you can confirm is orphaned.

## Configuration

`.env` / `.env.local` are loaded from the working directory, walking up to the nearest directory that has one.
Precedence, highest first: Settings dialog (DB) > shell env > `.env.local` > `.env`.
All variables are documented in `.env.example`; notable ones: `CHAMFER_MODEL`, `CHAMFER_PROVIDER`, `CHAMFER_MAX_CAD_RUNS`, `CHAMFER_DATA_DIR`, `PORT`, `CHAMFER_FAKE_LLM`.

## CI and release

- CI (`.github/workflows/ci.yml`): typecheck + tests + build on Node 22. It does not run `py-tests/` or e2e; run those locally before merging changes they cover.
- Release: pushing a `v*` tag publishes `packages/cli` to npm via Trusted Publishing (`release.yml`). The tag must exactly match the version in `packages/cli/package.json` or the workflow fails.

### Release versioning

- GitHub releases and npm packages must use the same semantic version line.
- The current release line is `0.2.x`; the next normal patch release after `v0.2.1` is `v0.2.2` with npm version `0.2.2`.
- Default to a patch increment unless the user explicitly requests a minor or major release.
- Derive the next version from the latest intended GitHub release, not from product-generation names or an accidentally higher npm version.
- Before preparing a release, compare `gh release list`, `git tag`, `npm view chamfer versions --json`, and `npm view chamfer dist-tags --json`.
- If GitHub tags, GitHub releases, npm versions, or npm dist-tags disagree, stop and confirm the intended version before publishing anything.
- Update both `packages/cli/package.json` and the `packages/cli` workspace entry in `package-lock.json` to the same version.
- Use the `v` prefix only for the Git tag and GitHub release; npm package metadata uses the bare version.
- Verify that the pushed tag, package manifest, lockfile, GitHub release, published npm version, and npm `latest` dist-tag all agree before declaring the release complete.
- Publish and verify corrected replacement versions before unpublishing an erroneous npm version because npm unpublish is irreversible and deleted name-version pairs cannot be reused.

## Gotchas

- The client test environment is jsdom; shims for `localStorage`, pointer capture, and `scrollIntoView` live in `packages/client/src/vitest.setup.ts`. Add new browser-API shims there, not in individual tests.
- build123d semantics: `intersect()` can return a `ShapeList`, and a `Hole` drills in both directions from its plane. Check `benchmarks/golden/` reference builds before changing geometry-adjacent prompt code.
- The agent is provider-agnostic through `@earendil-works/pi-ai`; do not hardcode provider-specific behavior in `packages/server/src/agent/`.
- pi-mcp-adapter resolves its config from `process.cwd()` at extension-load time; session creation briefly chdirs (serialized in `piSession.ts`). Do not parallelize session creation around it.
