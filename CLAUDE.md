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

Chamfer is an AI CAD designer that runs in the browser.
The LLM writes [build123d](https://build123d.readthedocs.io/) Python, which executes in a Pyodide web worker on the client; the geometry kernel verifies every result before it reaches the user.
Node >= 22.19 is required.

## Repo layout

npm workspaces monorepo:

- `packages/shared` - protocol types and DTOs shared by client and server (`src/index.ts`).
- `packages/client` - React 19 + Vite app. The interesting parts:
  - `src/agent/` - the agent loop (session, prompt, compaction, context policy, retry). It runs client-side; the server never sees the loop.
  - `src/cad/` - CAD execution: `cad.worker.ts` runs Pyodide, `cadClient.ts` is the main-thread API.
  - `public/py/harness.py` + `bootstrap.py` - the Python harness that executes build123d scripts, measures geometry, and enforces the verify gate. This is plain Python served as a static asset; it is tested natively by `py-tests/`.
  - `src/viewer/` - three.js viewer; `src/state/` - app state; `src/components/` - UI.
- `packages/server` - thin Hono server: LLM streaming proxy, settings/conversation stores (SQLite), `.env` loading, and the loopback Autodesk Fusion connector. Build123d CAD execution remains client-side.
- `packages/cli` - the publishable `chamfer` npm package; esbuild bundles server + built client into `dist/`.

`docs/internal/` is git-ignored and holds local working notes. Never commit anything into it or move its contents into tracked paths; this repo is public.

## Design and implementation rules

- **Read the pi packages before designing anything agent-loop related.**
  The loop is built on `@earendil-works/pi-agent-core` (agent/session/tool abstractions) and `@earendil-works/pi-ai` (provider-agnostic LLM streaming).
  Both ship extensive READMEs and typings in `node_modules/@earendil-works/*/`; read them first.
  Most "missing" capabilities (retries, tool wiring, event streams, message shapes) already exist there, and a design that fights their abstractions will be rejected.
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

### Python harness tests

The harness (`packages/client/public/py/harness.py`) is tested outside the browser with real build123d:

```bash
python3 -m venv py-tests/.venv && py-tests/.venv/bin/pip install -r py-tests/requirements.txt
py-tests/.venv/bin/pytest py-tests/
```

`py-tests/golden/golden.json` pins measurement output for known scripts.
If a harness change is *supposed* to alter output, regenerate with `python py-tests/golden/generate.py` and commit the diff with the change that justifies it.
Any harness edit should be covered here; the e2e suite only exercises it indirectly.

### E2E (Playwright)

- Runs its own dev stack on ports 5273 (client) / 8887 (API) so it does not collide with a live `npm run dev`.
- Most specs require a scripted fake LLM and a scratch database:

  ```bash
  CHAMFER_FAKE_LLM=1 CHAMFER_DATA_DIR=$(mktemp -d) npm run e2e
  ```

- `errors.spec.ts` intentionally runs in real mode (no fake LLM) against a fresh empty DB; read its header before touching it.
- Trap: `reuseExistingServer: true` means a server started *without* your env vars will be silently reused. If a spec behaves as if `CHAMFER_FAKE_LLM` is unset, kill stale listeners on 5273/8887/8787 first.

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
- build123d semantics: `intersect()` can return a `ShapeList`, and a `Hole` drills in both directions from its plane. Check `py-tests/` for regression cases before changing geometry-adjacent prompt or harness code.
- The agent loop is provider-agnostic through `@earendil-works/pi-ai`; do not hardcode provider-specific behavior in `src/agent/`.
