import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { deflateSync } from "node:zlib";
import { migrateDbBlobsToR2, R2AttachmentStore, type AttachmentBucket } from "./r2AttachmentStore";
import { AttachmentStorageError } from "../../server/src/imageBlobStore";

/** Minimal valid PNG of the given size (single IDAT, grayscale). */
function pngBytes(width: number, height: number): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes: Uint8Array): number => {
    let value = 0xffffffff;
    for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff]! ^ (value >>> 8);
    return (value ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array): Uint8Array => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set([...type].map((c) => c.charCodeAt(0)), 4);
    out.set(data, 8);
    const body = out.subarray(4, 8 + data.length);
    view.setUint32(8 + data.length, crc(body));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width);
  ihdrView.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  const raw = new Uint8Array(height * (width + 1)); // filter byte + pixels per row
  const idat = deflateSync(raw);
  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [signature, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const png = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}

/** In-memory AttachmentBucket enforcing the same sha256 checksum contract R2
 * verifies server-side, so a wrong hash fails in tests as it would live. */
class MemoryBucket implements AttachmentBucket {
  readonly objects = new Map<string, Uint8Array>();
  failWrites = false;
  failDeletes = false;

  async head(key: string) {
    const value = this.objects.get(key);
    return value ? { size: value.byteLength } : null;
  }

  async put(key: string, value: Uint8Array, options?: { sha256?: string }) {
    if (this.failWrites) throw new Error("r2 unavailable");
    const hash = createHash("sha256").update(value).digest("hex");
    if (options?.sha256 && options.sha256 !== hash) throw new Error("checksum mismatch");
    this.objects.set(key, value.slice());
  }

  async get(key: string) {
    const value = this.objects.get(key);
    if (!value) return null;
    return { arrayBuffer: async () => value.slice().buffer as ArrayBuffer };
  }

  async delete(key: string) {
    if (this.failDeletes) throw new Error("r2 unavailable");
    this.objects.delete(key);
  }

  async list({ prefix, cursor }: { prefix: string; cursor?: string }) {
    const keys = [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort();
    // Single-object pages exercise the pagination loop with real cursors.
    const start = cursor ? Number(cursor) : 0;
    const objects = keys.slice(start, start + 1).map((key) => ({ key }));
    const truncated = start + 1 < keys.length;
    return { objects, truncated, cursor: truncated ? String(start + 1) : undefined };
  }
}

function fixture() {
  const bucket = new MemoryBucket();
  return { bucket, store: new R2AttachmentStore(bucket, "users/do-1") };
}

describe("R2AttachmentStore", () => {
  it("round-trips a PNG under the user prefix and dedupes by content", async () => {
    const { bucket, store } = fixture();
    const data = pngBytes(4, 4);

    const stored = await store.write(data, "image/png");
    expect(stored.created).toBe(true);
    expect(stored.byteSize).toBe(data.byteLength);
    expect(stored.blobPath).toMatch(/^images\/[0-9a-f]{2}\/[0-9a-f]{64}$/);
    expect(bucket.objects.has(`users/do-1/${stored.blobPath}`)).toBe(true);

    const again = await store.write(data, "image/png");
    expect(again.created).toBe(false);
    expect(again.contentHash).toBe(stored.contentHash);

    const read = await store.read(stored);
    expect(Buffer.from(read).equals(Buffer.from(data))).toBe(true);
  });

  it("rejects a declared mime that does not match the bytes", async () => {
    const { store } = fixture();
    await expect(store.write(pngBytes(2, 2), "image/jpeg")).rejects.toThrow(AttachmentStorageError);
  });

  it("rejects non-image bytes", async () => {
    const { store } = fixture();
    await expect(store.write(new TextEncoder().encode("not an image"), "image/png")).rejects.toThrow(
      AttachmentStorageError,
    );
  });

  it("wraps bucket write failures as write-failed", async () => {
    const { bucket, store } = fixture();
    bucket.failWrites = true;
    await expect(store.write(pngBytes(4, 4), "image/png")).rejects.toMatchObject({ code: "write-failed" });
  });

  it("detects corruption against recorded metadata", async () => {
    const { bucket, store } = fixture();
    const stored = await store.write(pngBytes(4, 4), "image/png");
    bucket.objects.set(`users/do-1/${stored.blobPath}`, pngBytes(5, 5));
    await expect(store.read(stored)).rejects.toMatchObject({ code: "corrupt" });
  });

  it("reports a missing object", async () => {
    const { store } = fixture();
    const stored = await store.write(pngBytes(4, 4), "image/png");
    await store.remove(stored.blobPath);
    await expect(store.read(stored)).rejects.toMatchObject({ code: "missing" });
  });

  it("cannot read another user's blob through its own prefix", async () => {
    const bucket = new MemoryBucket();
    const theirs = new R2AttachmentStore(bucket, "users/do-other");
    const stored = await theirs.write(pngBytes(4, 4), "image/png");

    const mine = new R2AttachmentStore(bucket, "users/do-1");
    await expect(mine.read(stored)).rejects.toMatchObject({ code: "missing" });
  });

  it("maintain removes unreferenced blobs within the prefix and keeps referenced ones", async () => {
    const bucket = new MemoryBucket();
    const store = new R2AttachmentStore(bucket, "users/do-1");
    const other = new R2AttachmentStore(bucket, "users/do-other");
    const kept = await store.write(pngBytes(4, 4), "image/png");
    const dropped = await store.write(pngBytes(6, 6), "image/png");
    const foreign = await other.write(pngBytes(8, 8), "image/png");

    const report = await store.maintain(new Set([kept.blobPath]));

    expect(report.removed).toEqual([dropped.blobPath]);
    expect(report.fileSystemAfter).toEqual([kept.blobPath].sort());
    await expect(store.read(kept)).resolves.toBeDefined();
    await expect(store.read(dropped)).rejects.toMatchObject({ code: "missing" });
    await expect(other.read(foreign)).resolves.toBeDefined();
  });

  it("maintain reports a failed removal and succeeds on retry", async () => {
    const { bucket, store } = fixture();
    const orphan = await store.write(pngBytes(4, 4), "image/png");

    bucket.failDeletes = true;
    expect((await store.maintain(new Set())).failed).toEqual([orphan.blobPath]);
    bucket.failDeletes = false;
    expect((await store.maintain(new Set())).removed).toEqual([orphan.blobPath]);
  });
});

const CHUNK_BYTES = 1_000_000;

function seedLegacyBlob(db: DatabaseSync, data: Uint8Array, mime: string, contentHash?: string): string {
  db.exec(`
    CREATE TABLE IF NOT EXISTS online_image_blobs (
      blob_path TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      chunk BLOB NOT NULL,
      content_hash TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      mime TEXT NOT NULL,
      PRIMARY KEY (blob_path, chunk_index)
    );
  `);
  const hash = contentHash ?? createHash("sha256").update(data).digest("hex");
  const blobPath = `images/${hash.slice(0, 2)}/${hash}`;
  const insert = db.prepare(
    "INSERT INTO online_image_blobs (blob_path, chunk_index, chunk, content_hash, byte_size, mime) VALUES (?, ?, ?, ?, ?, ?)",
  );
  for (let index = 0; index * CHUNK_BYTES < data.byteLength; index += 1) {
    insert.run(blobPath, index, data.slice(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES), hash, data.byteLength, mime);
  }
  return blobPath;
}

describe("migrateDbBlobsToR2", () => {
  it("is a no-op on a database that never held blobs", async () => {
    const { store } = fixture();
    await expect(migrateDbBlobsToR2(new DatabaseSync(":memory:"), store)).resolves.toBeUndefined();
  });

  it("moves legacy SQLite blobs into R2 and drops the table", async () => {
    const { store } = fixture();
    const db = new DatabaseSync(":memory:");
    const data = pngBytes(4, 4);
    const blobPath = seedLegacyBlob(db, data, "image/png");
    const contentHash = blobPath.split("/").at(-1)!;

    await migrateDbBlobsToR2(db, store);

    const read = await store.read({ blobPath, contentHash, byteSize: data.byteLength, mime: "image/png" });
    expect(Buffer.from(read).equals(Buffer.from(data))).toBe(true);
    expect(
      db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'online_image_blobs'").get(),
    ).toBeUndefined();
  });

  it("drops rows whose bytes no longer match their recorded hash", async () => {
    const { bucket, store } = fixture();
    const db = new DatabaseSync(":memory:");
    seedLegacyBlob(db, pngBytes(4, 4), "image/png", "f".repeat(64));

    await migrateDbBlobsToR2(db, store);

    expect(bucket.objects.size).toBe(0);
    expect(
      db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'online_image_blobs'").get(),
    ).toBeUndefined();
  });

  it("keeps rows when R2 is unavailable so the next wake retries", async () => {
    const { bucket, store } = fixture();
    const db = new DatabaseSync(":memory:");
    const data = pngBytes(4, 4);
    const blobPath = seedLegacyBlob(db, data, "image/png");
    const contentHash = blobPath.split("/").at(-1)!;

    bucket.failWrites = true;
    await expect(migrateDbBlobsToR2(db, store)).rejects.toThrow();
    expect(db.prepare("SELECT COUNT(*) AS n FROM online_image_blobs").get()).toMatchObject({ n: 1 });

    bucket.failWrites = false;
    await migrateDbBlobsToR2(db, store);
    const read = await store.read({ blobPath, contentHash, byteSize: data.byteLength, mime: "image/png" });
    expect(Buffer.from(read).equals(Buffer.from(data))).toBe(true);
  });
});
