import { describe, expect, it } from "vitest";
import type { ArtifactExport } from "../../server/src/agent/artifactStore";
import { describeArtifactStoreContract } from "../../server/src/agent/artifactStore.contract";
import { R2ArtifactStore, type ArtifactObjectBucket } from "./r2ArtifactStore";

class MemoryArtifactBucket implements ArtifactObjectBucket {
  readonly objects = new Map<string, { bytes: Uint8Array; customMetadata?: Record<string, string> }>();

  async head(key: string) {
    const object = this.objects.get(key);
    return object ? { customMetadata: object.customMetadata } : null;
  }

  async put(key: string, value: Uint8Array, options?: { customMetadata?: Record<string, string> }) {
    this.objects.set(key, { bytes: new Uint8Array(value), customMetadata: options?.customMetadata });
  }

  async get(key: string) {
    const object = this.objects.get(key);
    if (!object) return null;
    return {
      customMetadata: object.customMetadata,
      arrayBuffer: async () => object.bytes.slice().buffer as ArrayBuffer,
    };
  }
}

/** Plays the agent's rewrite: content plus a strictly later observation mtime,
 * the same signal shape observeExport hands the local store. */
function exportHarness() {
  let mtime = 1_000;
  return (content: string): ArtifactExport => {
    mtime += 1_000;
    return { mtimeMs: mtime, bytes: async () => new TextEncoder().encode(content) };
  };
}

describeArtifactStoreContract("R2", () => {
  const writeExport = exportHarness();
  return {
    store: new R2ArtifactStore(new MemoryArtifactBucket(), "users/do-1"),
    writeExport: async (_conversationId, content) => writeExport(content),
  };
});

describe("R2ArtifactStore persistence", () => {
  it("keeps the revision counter across store instances (no mtime contract on R2)", async () => {
    const bucket = new MemoryArtifactBucket();
    const writeExport = exportHarness();
    const first = new R2ArtifactStore(bucket, "users/do-1");
    await first.record("conv-1", writeExport("solid a"));
    const second = await first.record("conv-1", writeExport("solid b"));
    expect(second.revision).toBe(2);

    // A fresh instance (DO restart) sees the persisted counter, not a reset.
    const restarted = new R2ArtifactStore(bucket, "users/do-1");
    const reRecorded = await restarted.record("conv-1", writeExport("solid c"));
    expect(reRecorded).toEqual({ revision: 3, updated: true });
    expect((await restarted.current("conv-1"))?.revision).toBe(3);
  });

  it("treats a re-drain of an already-recorded rewrite as a no-op across restarts", async () => {
    const bucket = new MemoryArtifactBucket();
    const writeExport = exportHarness();
    await new R2ArtifactStore(bucket, "users/do-1").record("conv-1", writeExport("solid a"));
    const observedAgain: ArtifactExport = {
      mtimeMs: 2_000,
      bytes: async () => {
        throw new Error("a no-op record must not fetch bytes");
      },
    };
    const restarted = new R2ArtifactStore(bucket, "users/do-1");
    expect(await restarted.record("conv-1", observedAgain)).toEqual({ revision: 1, updated: false });
  });

  it("scopes keys under the owning Durable Object's prefix", async () => {
    const bucket = new MemoryArtifactBucket();
    const writeExport = exportHarness();
    await new R2ArtifactStore(bucket, "users/do-1").record("conv-1", writeExport("solid a"));
    expect([...bucket.objects.keys()]).toEqual(["users/do-1/agent/conv-1/artifact.stl"]);
  });
});
