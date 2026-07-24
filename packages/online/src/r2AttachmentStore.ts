import { createHash } from "node:crypto";
import { imageSize } from "image-size";
import type { DatabaseSync } from "node:sqlite";
import {
  AttachmentStorageError,
  type AttachmentFileMaintenanceReport,
  type AttachmentMaintenanceOptions,
  type ImageBlobMetadata,
  type ImageBlobStore,
  type StoredImageBlob,
} from "../../server/src/imageBlobStore";

const MEDIA_TYPES = new Map([
  ["gif", "image/gif"],
  ["jpg", "image/jpeg"],
  ["png", "image/png"],
  ["webp", "image/webp"],
]);

const FINAL_BLOB_PATH = /^images\/[0-9a-f]{2}\/[0-9a-f]{64}$/;

/** The R2Bucket surface the store depends on, kept structural so tests can
 * substitute an in-memory bucket without @cloudflare/workers-types casts. */
export interface AttachmentBucket {
  head(key: string): Promise<{ size: number } | null>;
  put(
    key: string,
    value: Uint8Array,
    options?: { httpMetadata?: { contentType?: string }; sha256?: string },
  ): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  delete(key: string): Promise<void>;
  list(options: {
    prefix: string;
    cursor?: string;
  }): Promise<{ objects: Array<{ key: string }>; truncated: boolean; cursor?: string }>;
}

function decodedMime(data: Uint8Array): string {
  try {
    const { width, height, type } = imageSize(data);
    const mime = type ? MEDIA_TYPES.get(type) : undefined;
    if (!mime || !width || !height) throw new Error("unsupported image");
    return mime;
  } catch (cause) {
    if (cause instanceof AttachmentStorageError) throw cause;
    throw new AttachmentStorageError("unsupported-media", { cause });
  }
}

/** ImageBlobStore backed by an R2 bucket shared across users. Isolation comes
 * from the key prefix: every key lives under the owning Durable Object's id,
 * which the Worker derives from the authenticated user id, so one user's store
 * can never name another user's objects. Blob paths recorded in attachment
 * metadata keep the same content-addressed `images/aa/<sha256>` format as the
 * filesystem store; the prefix is a storage detail invisible to the database.
 * Validation mirrors the filesystem AttachmentStore, with sharp's full decode
 * replaced by an image-header parse (no native codecs on workerd); R2 verifies
 * the sha256 checksum server-side on every put. */
export class R2AttachmentStore implements ImageBlobStore {
  constructor(
    private readonly bucket: AttachmentBucket,
    private readonly keyPrefix: string,
  ) {}

  private key(blobPath: string): string {
    return `${this.keyPrefix}/${blobPath}`;
  }

  async write(data: Uint8Array, declaredMime: string): Promise<StoredImageBlob> {
    const mime = decodedMime(data);
    if (mime !== declaredMime) throw new AttachmentStorageError("unsupported-media");

    const contentHash = createHash("sha256").update(data).digest("hex");
    const blobPath = `images/${contentHash.slice(0, 2)}/${contentHash}`;
    try {
      const existing = await this.bucket.head(this.key(blobPath));
      if (existing) {
        return { contentHash, byteSize: data.byteLength, mime, blobPath, created: false };
      }
      await this.bucket.put(this.key(blobPath), data, {
        httpMetadata: { contentType: mime },
        sha256: contentHash,
      });
    } catch (cause) {
      throw new AttachmentStorageError("write-failed", { cause });
    }
    return { contentHash, byteSize: data.byteLength, mime, blobPath, created: true };
  }

  async read(metadata: ImageBlobMetadata): Promise<Uint8Array> {
    const object = await this.bucket.get(this.key(metadata.blobPath));
    if (!object) throw new AttachmentStorageError("missing");
    const data = new Uint8Array(await object.arrayBuffer());

    if (data.byteLength !== metadata.byteSize) throw new AttachmentStorageError("corrupt");
    const hash = createHash("sha256").update(data).digest("hex");
    if (hash !== metadata.contentHash) throw new AttachmentStorageError("corrupt");
    if (decodedMime(data) !== metadata.mime) throw new AttachmentStorageError("unsupported-media");
    return data;
  }

  async remove(blobPath: string): Promise<void> {
    await this.bucket.delete(this.key(blobPath));
  }

  async maintain(
    referencedBlobPaths: ReadonlySet<string>,
    _options: AttachmentMaintenanceOptions = {},
  ): Promise<AttachmentFileMaintenanceReport> {
    const before: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.bucket.list({ prefix: `${this.keyPrefix}/images/`, cursor });
      for (const object of page.objects) before.push(object.key.slice(this.keyPrefix.length + 1));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    before.sort();

    const removed: string[] = [];
    const failed: string[] = [];
    for (const blobPath of before) {
      if (!FINAL_BLOB_PATH.test(blobPath) || referencedBlobPaths.has(blobPath)) continue;
      try {
        await this.bucket.delete(this.key(blobPath));
        removed.push(blobPath);
      } catch {
        failed.push(blobPath);
      }
    }
    return {
      fileSystemBefore: before,
      fileSystemAfter: before.filter((path) => !removed.includes(path)),
      removed,
      failed,
    };
  }
}

/** One-time move of blobs out of the Durable Object's SQLite database (the
 * previous store chunked them into `online_image_blobs` rows) into R2. Runs in
 * the DO constructor under blockConcurrencyWhile: each blob is reassembled,
 * verified against its recorded hash, put to R2, and only then deleted from
 * SQLite, so a crash mid-migration retries the remainder on the next wake.
 * Corrupt rows (hash mismatch) are dropped - reads of them already failed.
 * The table is removed once empty; fresh objects never create it. */
export async function migrateDbBlobsToR2(db: DatabaseSync, store: R2AttachmentStore): Promise<void> {
  const table = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'online_image_blobs'")
    .get();
  if (!table) return;

  const blobs = db
    .prepare("SELECT DISTINCT blob_path AS blobPath, content_hash AS contentHash, mime FROM online_image_blobs")
    .all() as unknown as Array<{ blobPath: string; contentHash: string; mime: string }>;
  const deleteRows = db.prepare("DELETE FROM online_image_blobs WHERE blob_path = ?");
  for (const blob of blobs) {
    const rows = db
      .prepare("SELECT chunk FROM online_image_blobs WHERE blob_path = ? ORDER BY chunk_index")
      .all(blob.blobPath) as unknown as Array<{ chunk: ArrayBuffer }>;
    const total = rows.reduce((sum, row) => sum + row.chunk.byteLength, 0);
    const data = new Uint8Array(total);
    let offset = 0;
    for (const row of rows) {
      data.set(new Uint8Array(row.chunk), offset);
      offset += row.chunk.byteLength;
    }
    const hash = createHash("sha256").update(data).digest("hex");
    if (hash === blob.contentHash) {
      try {
        await store.write(data, blob.mime);
      } catch (error) {
        // A validation failure can never succeed on retry; reads of the blob
        // already failed the same check, so its rows are dead weight. Anything
        // else (R2 unavailable) propagates and keeps the rows for a later wake.
        const unmigratable =
          error instanceof AttachmentStorageError && error.code === "unsupported-media";
        if (!unmigratable) throw error;
      }
    }
    deleteRows.run(blob.blobPath);
  }
  db.exec("DROP TABLE online_image_blobs");
}
