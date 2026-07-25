import type {
  ArtifactExport,
  ArtifactRecord,
  ArtifactStore,
  CurrentArtifact,
} from "../../server/src/agent/artifactStore";

/** The R2Bucket surface the store depends on, kept structural so tests can
 * substitute an in-memory bucket without @cloudflare/workers-types casts. */
export interface ArtifactObjectBucket {
  head(key: string): Promise<{ customMetadata?: Record<string, string> } | null>;
  put(
    key: string,
    value: Uint8Array,
    options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> },
  ): Promise<unknown>;
  get(key: string): Promise<{ customMetadata?: Record<string, string>; arrayBuffer(): Promise<ArrayBuffer> } | null>;
}

/** ArtifactStore backed by an R2 bucket (ADR 0003: by turn end the artifact
 * has left the container), so the artifact route keeps serving while the
 * container sleeps. R2 has no mtime contract, so the revision is a persisted
 * counter: each object carries { revision, sourceMtimeMs } as customMetadata,
 * where sourceMtimeMs is the container-side rewrite signal from the observed
 * export. A record() whose signal matches the stored one is a no-op (no bytes
 * fetched, no write); a new signal copies the bytes and bumps the counter.
 * Persisting both on the object keeps revisions stable across DO restarts, so
 * viewer ETags keep matching and a re-drain of an unchanged artifact never
 * fires a spurious artifact_updated. Isolation follows the attachment store's
 * rule: every key lives under the owning Durable Object's id prefix. */
export class R2ArtifactStore implements ArtifactStore {
  constructor(
    private readonly bucket: ArtifactObjectBucket,
    private readonly keyPrefix: string,
  ) {}

  private key(conversationId: string): string {
    return `${this.keyPrefix}/agent/${conversationId}/artifact.stl`;
  }

  async record(conversationId: string, exportFile: ArtifactExport): Promise<ArtifactRecord> {
    const key = this.key(conversationId);
    const sourceMtimeMs = String(Math.floor(exportFile.mtimeMs));
    const existing = await this.bucket.head(key);
    const storedRevision = Number(existing?.customMetadata?.revision ?? 0);
    if (existing && existing.customMetadata?.sourceMtimeMs === sourceMtimeMs) {
      return { revision: storedRevision, updated: false };
    }
    const revision = storedRevision + 1;
    await this.bucket.put(key, await exportFile.bytes(), {
      httpMetadata: { contentType: "model/stl" },
      customMetadata: { revision: String(revision), sourceMtimeMs },
    });
    return { revision, updated: true };
  }

  async current(conversationId: string): Promise<CurrentArtifact | undefined> {
    const object = await this.bucket.get(this.key(conversationId));
    if (!object) return undefined;
    return {
      revision: Number(object.customMetadata?.revision ?? 0),
      bytes: async () => new Uint8Array(await object.arrayBuffer()),
    };
  }

  async exists(conversationId: string): Promise<boolean> {
    // A metadata HEAD, so a list-route existence check never streams the object.
    return (await this.bucket.head(this.key(conversationId))) !== null;
  }
}
