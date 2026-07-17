# Fusion release-integrity gate

Autodesk Fusion remains hidden from normal users unless a complete release-integrity report names the exact runnable CLI package. `CHAMFER_EXPERIMENTAL_FUSION=1` is the controlled-tester override; it exposes Fusion but does not change a no-go verdict, and the chooser shows every current limitation.

Build the release artifact first, then run the deterministic browser seam:

```bash
npm run build
npm run fusion:gate -- \
  --artifact packages/cli \
  --release chamfer@0.2.2 \
  --out fusion-release-integrity.json
```

The runner refuses tracked worktree changes so the recorded Git commit always names the tested source.

That report is deliberately `no-go`: normal-user promotion also requires live proof. With Fusion running and no valuable unsaved work open, authorize the runner to create and discard marked disposable documents:

```bash
npm run fusion:gate -- \
  --artifact packages/cli \
  --release chamfer@0.2.2 \
  --out fusion-release-integrity.json \
  --live --create-disposable \
  --endpoint http://127.0.0.1:27182/mcp
```

The live flags are both required. Only the exact `http://127.0.0.1:<port>/mcp` endpoint is accepted. The runner first executes the safety probe; any handshake, identity, design-eligibility, Undo, rollback, manual-edit, ambiguity, or camera failure stops later live fixtures.

The report records the dated verdict, every required fake and live result, the three stable fixture identities, Fusion and MCP versions, the Git commit, the release artifact SHA-256, and content hashes for connector, policy, skills, and fixtures. Missing, skipped, failed, or unsupported coverage is a no-go.

To use a passing report with a development server, set both values explicitly:

```bash
CHAMFER_FUSION_RELEASE_INTEGRITY_REPORT=/absolute/path/to/fusion-release-integrity.json
CHAMFER_RELEASE_ARTIFACT_SHA256=<sha256-of-the-tested-cli-package>
```

The published CLI deterministically hashes its own `package.json`, launcher, server bundle, and all bundled client assets. It overwrites any inherited hash value, and a report for any other package bytes is ignored.
