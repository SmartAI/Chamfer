# Brief: npx release of Chamfer v2

Date: 2026-07-10 · Status: approved (decision round 2026-07-10)

## Goal

`npx chamfer` starts the full app (server + built client) on any machine with
Node >= 22.19, storing data in a user data dir. A tag push (`v2.0.0`) builds,
tests, and publishes to npm from GitHub Actions with provenance. The old
PyPI-era artifacts get a pointer to the new install path.

**Non-goals:** hosted deployment / free trial (later, BYOK-first), publishing
the workspace packages individually, bundling Pyodide (stays on CDN),
changing any product behavior.

## Decisions (batched round, all confirmed)

| Decision | Choice |
|---|---|
| npm package name | `chamfer` (available, verified 2026-07-10) |
| First version | `2.0.0` (matches v2 branding; v0.x tags are PyPI-era) |
| Old PyPI `chamfer-cad` | Deprecate with pointer (no yank) |
| Release flow | Tag push `v*` → GitHub Actions → npm Trusted Publishing (OIDC) + provenance |

Defaults (not asked): single published package assembled in a new
`packages/cli` workspace — esbuild bundles server + `@chamfer/shared` into
one file (npm deps stay external as regular `dependencies`), client `dist/`
copied in at build time. `@chamfer/*` workspace packages stay private.

## Findings that shaped the plan

- Repo history was rewritten for v2 (single commit); the PyPI `release.yml`
  no longer exists here — only `ci.yml`. "Deep clean" = build the npm flow
  fresh, nothing to delete.
- v1 leftovers living outside the repo: tags/releases `v0.1.0–v0.2.0`
  (keep — deleting published releases breaks links) and `chamfer-cad` on PyPI.
- PyPI has no edit-description-without-release mechanism; deprecation pointer
  goes in the GitHub release notes for v0.2.0. A metadata-only
  `chamfer-cad 0.2.1` stub is possible later if Min wants a PyPI-side notice.
- npx blockers: no `bin`; root `private: true`; server runs via `tsx`
  (dev tool, no emit build); DB path `data/chamfer.db` resolves relative to
  source → would write into the npm cache under npx.
- Pyodide + build123d load from jsDelivr at runtime → package stays small.
- Cleanliness: 138/138 tests pass, typecheck clean, no secrets tracked,
  Apache-2.0 + NOTICE present.

## Work items

1. Server refactor: extract `startServer({ dbPath, clientDist, port })`;
   default DB path `~/.chamfer/chamfer.db` (override `CHAMFER_DATA_DIR`);
   dev entry keeps repo-local `data/`.
2. `packages/cli`: package `chamfer@2.0.0`, `bin`, esbuild bundle of
   server+shared, copies client dist, `files` whitelist, engines node >=22.19.
3. Root/CI: root build includes cli; `ci.yml` gains a build step.
4. `release.yml`: on tag `v*` → npm ci, typecheck, test, build,
   `npm publish --provenance` from `packages/cli` (OIDC, `id-token: write`).
5. README quickstart: `npx chamfer` first, contributor dev flow second.
6. Edit GitHub release v0.2.0 notes with pointer to `npx chamfer`.

## Acceptance checks (deterministic)

- `npm run typecheck --workspaces` and `npm run test --workspaces` exit 0.
- `npm run build` exit 0; `npm pack -w chamfer` produces a tarball.
- Install the tarball into an empty temp dir, run its bin with
  `CHAMFER_DATA_DIR=$(mktemp -d)`: server prints URL; `curl /` returns the
  SPA index; `curl /api/...` responds; DB file appears under the temp data
  dir (NOT the install dir).
- `gh release view v0.2.0` body contains the npx pointer.
- Workflow YAML parses (`gh workflow` after push / actionlint if available).

## Manual steps for Min (cannot be automated)

1. First publish must be manual (npm requires the package to exist before
   Trusted Publishing can be configured): `npm login`, then from repo root
   `npm publish -w chamfer` (or use a granular token once).
2. On npmjs.com → package settings → add Trusted Publisher:
   repo `SmartAI/Chamfer`, workflow `release.yml`.
3. Subsequent releases: bump version, push tag `vX.Y.Z`.

## Deviations

- esbuild `packages: "external"` also externalized `@chamfer/shared` →
  ERR_MODULE_NOT_FOUND from the installed tarball. Switched to an explicit
  `external` list derived from the cli package's `dependencies`. Caught by the
  tarball smoke test — keep that check for future packaging changes.
- First CI run failed: `packages/cli/scripts/build.mjs` never got committed
  because the repo-local `.git/info/exclude` ignores `scripts/`. Force-added
  (`git add -f`); the local exclude file was left untouched.
