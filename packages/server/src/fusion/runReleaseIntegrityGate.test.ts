import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fakeCoverageResults, hashReleaseArtifact, observationsFromPlaywright } from "./runReleaseIntegrityGate";

describe("release integrity runner coverage", () => {
  it("normalizes Playwright JSON without treating absent results as passing", () => {
    const observations = observationsFromPlaywright({ suites: [{
      file: "/repo/e2e/fusion-atomic-action.spec.ts",
      specs: [{ title: "production agent path creates one verified parametric Fusion solid with one native Undo entry", tests: [{ results: [{ status: "passed" }] }] }],
    }] });
    expect(observations).toEqual([{
      file: "fusion-atomic-action.spec.ts",
      title: "production agent path creates one verified parametric Fusion solid with one native Undo entry",
      status: "passed",
    }]);
    expect(fakeCoverageResults(observations).find((result) => result.id === "atomic-action")).toMatchObject({ status: "passed" });
    expect(fakeCoverageResults(observations).find((result) => result.id === "FUS-TEXT-001")).toMatchObject({ status: "failed" });
  });

  it("propagates a skipped required test into the gate result", () => {
    const results = fakeCoverageResults([{
      file: "fusion-readiness.spec.ts",
      title: "Fusion readiness covers every fail-closed state and reconnects across all UI surfaces",
      status: "skipped",
    }]);
    expect(results.find((result) => result.id === "readiness-states")).toMatchObject({ status: "skipped" });
  });

  it("identifies the complete runnable CLI package, including client bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "chamfer-release-hash-"));
    try {
      await mkdir(join(root, "bin"), { recursive: true });
      await mkdir(join(root, "dist/client/assets"), { recursive: true });
      await writeFile(join(root, "package.json"), "package");
      await writeFile(join(root, "bin/chamfer.js"), "launcher");
      await writeFile(join(root, "dist/server.mjs"), "server");
      await writeFile(join(root, "dist/client/index.html"), "client");
      await writeFile(join(root, "dist/client/assets/app.js"), "asset-v1");

      const before = await hashReleaseArtifact(root);
      await writeFile(join(root, "dist/client/assets/app.js"), "asset-v2");
      const after = await hashReleaseArtifact(root);

      expect(before).toMatch(/^[0-9a-f]{64}$/);
      expect(after).toMatch(/^[0-9a-f]{64}$/);
      expect(after).not.toBe(before);
      expect(after).not.toBe(createHash("sha256").update("server").digest("hex"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
