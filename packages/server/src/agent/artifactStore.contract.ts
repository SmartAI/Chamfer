import { describe, expect, it } from "vitest";
import type { ArtifactExport, ArtifactStore } from "./artifactStore";

/** One backend under contract test. writeExport plays the agent's move - a
 * rewrite of the conversation's contracted export, landing after every
 * previous write - and returns the observation the session host would hand
 * to record(). */
export interface ArtifactStoreHarness {
  store: ArtifactStore;
  writeExport(conversationId: string, content: string): Promise<ArtifactExport>;
}

/** The revision contract every ArtifactStore backend must satisfy. The local
 * filesystem backend runs it today; the R2 backend reuses it unchanged when
 * the container milestone lands. */
export function describeArtifactStoreContract(
  name: string,
  makeHarness: () => ArtifactStoreHarness,
): void {
  describe(`artifact store contract (${name})`, () => {
    it("has no current artifact before an export is recorded", async () => {
      const { store } = makeHarness();
      expect(await store.current("conv-1")).toBeUndefined();
    });

    it("advances the revision strictly on every recorded rewrite", async () => {
      const { store, writeExport } = makeHarness();
      const first = await store.record("conv-1", await writeExport("conv-1", "solid a"));
      const second = await store.record("conv-1", await writeExport("conv-1", "solid b"));
      expect(first.updated).toBe(true);
      expect(second.updated).toBe(true);
      expect(second.revision).toBeGreaterThan(first.revision);
    });

    it("keeps the revision and reports no update for a no-op record", async () => {
      const { store, writeExport } = makeHarness();
      const observed = await writeExport("conv-1", "solid a");
      const first = await store.record("conv-1", observed);
      expect(await store.record("conv-1", observed)).toEqual({ revision: first.revision, updated: false });
    });

    it("serves the latest recorded bytes under the recorded revision", async () => {
      const { store, writeExport } = makeHarness();
      await store.record("conv-1", await writeExport("conv-1", "solid a"));
      const latest = await store.record("conv-1", await writeExport("conv-1", "solid b"));
      const current = await store.current("conv-1");
      expect(current?.revision).toBe(latest.revision);
      expect(new TextDecoder().decode(await current!.bytes())).toBe("solid b");
    });

    it("tracks the rewrite watermark per conversation, not globally", async () => {
      const { store, writeExport } = makeHarness();
      const observed = await writeExport("conv-1", "solid a");
      await store.record("conv-1", observed);
      expect((await store.record("conv-2", await writeExport("conv-2", "solid c"))).updated).toBe(true);
      expect((await store.record("conv-1", observed)).updated).toBe(false);
    });
  });
}
