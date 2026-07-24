import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ARTIFACT_FILENAME,
  conversationAgentDir,
  LocalArtifactStore,
  observeExport,
} from "./artifactStore";
import { describeArtifactStoreContract, type ArtifactStoreHarness } from "./artifactStore.contract";

const dataDirs: string[] = [];
afterEach(() => {
  for (const dir of dataDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Writes the contracted export where the agent would, with an explicitly
 * advancing mtime: real rewrites land later, and the explicit clock keeps
 * the test deterministic on filesystems with coarse mtime granularity. */
function localHarness(): ArtifactStoreHarness & { dataDir: string } {
  const dataDir = mkdtempSync(join(tmpdir(), "chamfer-artifact-store-"));
  dataDirs.push(dataDir);
  let clock = 1_000;
  return {
    dataDir,
    store: new LocalArtifactStore(dataDir),
    async writeExport(conversationId, content) {
      const dir = conversationAgentDir(dataDir, conversationId);
      mkdirSync(dir, { recursive: true });
      const path = join(dir, ARTIFACT_FILENAME);
      writeFileSync(path, content);
      clock += 1_000;
      utimesSync(path, new Date(clock), new Date(clock));
      return observeExport(dir)!;
    },
  };
}

describeArtifactStoreContract("local filesystem", localHarness);

describe("LocalArtifactStore", () => {
  it("derives revisions from the export mtime, so ETags survive a restart", async () => {
    const harness = localHarness();
    const observed = await harness.writeExport("conv-1", "solid a");
    expect((await harness.store.record("conv-1", observed)).revision).toBe(Math.floor(observed.mtimeMs));
    // A store built by a restarted server serves the same revision without
    // any record() having run.
    const reborn = new LocalArtifactStore(harness.dataDir);
    const current = await reborn.current("conv-1");
    expect(current?.revision).toBe(Math.floor(observed.mtimeMs));
    expect(new TextDecoder().decode(await current!.bytes())).toBe("solid a");
  });

  it("observeExport is undefined until the agent exports", () => {
    const harness = localHarness();
    expect(observeExport(conversationAgentDir(harness.dataDir, "conv-1"))).toBeUndefined();
  });
});
