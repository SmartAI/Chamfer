import { createHash, randomUUID } from "node:crypto";
import {
  accessSync,
  constants,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import sharp from "sharp";

const MEDIA_TYPES = new Map([
  ["gif", "image/gif"],
  ["jpeg", "image/jpeg"],
  ["png", "image/png"],
  ["webp", "image/webp"],
]);

export type AttachmentStorageErrorCode =
  | "missing"
  | "corrupt"
  | "unsupported-media"
  | "path-rejected"
  | "write-failed";

export class AttachmentStorageError extends Error {
  constructor(readonly code: AttachmentStorageErrorCode, options?: ErrorOptions) {
    super(code, options);
  }
}

export interface StoredImageBlob {
  contentHash: string;
  byteSize: number;
  mime: string;
  blobPath: string;
  created: boolean;
}

export interface ImageBlobMetadata {
  contentHash: string;
  byteSize: number;
  mime: string;
  blobPath: string;
}

export interface AttachmentFileSystem {
  rename(source: string, destination: string): void;
  remove(path: string): void;
}

export interface AttachmentStoreOptions {
  fileSystem?: Partial<AttachmentFileSystem>;
}

export interface AttachmentMaintenanceOptions {
  now?: () => number;
  temporaryMaxAgeMs?: number;
}

export interface AttachmentFileMaintenanceReport {
  fileSystemBefore: string[];
  fileSystemAfter: string[];
  removed: string[];
  failed: string[];
}

const DEFAULT_TEMPORARY_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const FINAL_BLOB_PATH = /^images\/[0-9a-f]{2}\/[0-9a-f]{64}$/;

async function decodedMime(data: Uint8Array): Promise<string> {
  try {
    const image = sharp(data, { animated: true, failOn: "error" });
    const metadata = await image.metadata();
    const mime = metadata.format ? MEDIA_TYPES.get(metadata.format) : undefined;
    if (!mime || !metadata.width || !metadata.height) throw new Error("unsupported image");
    await image.raw().toBuffer();
    return mime;
  } catch (cause) {
    throw new AttachmentStorageError("unsupported-media", { cause });
  }
}

function isContained(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
}

export class AttachmentStore {
  private readonly root: string;
  private readonly temporaryRoot: string;
  private readonly rename: AttachmentFileSystem["rename"];
  private readonly removeFile: AttachmentFileSystem["remove"];

  constructor(dataDir: string, options: AttachmentStoreOptions = {}) {
    this.root = resolve(dataDir, "images");
    this.temporaryRoot = join(this.root, ".tmp");
    this.rename = options.fileSystem?.rename ?? renameSync;
    this.removeFile = options.fileSystem?.remove ?? ((path) => rmSync(path, { force: true }));
    mkdirSync(this.temporaryRoot, { recursive: true });
  }

  async write(data: Uint8Array, declaredMime: string): Promise<StoredImageBlob> {
    const mime = await decodedMime(data);
    if (mime !== declaredMime) throw new AttachmentStorageError("unsupported-media");

    const contentHash = createHash("sha256").update(data).digest("hex");
    const blobPath = join("images", contentHash.slice(0, 2), contentHash);
    const finalPath = this.resolveBlobPath(blobPath);
    const temporaryPath = join(this.temporaryRoot, `${randomUUID()}.partial`);
    mkdirSync(dirname(finalPath), { recursive: true });

    try {
      writeFileSync(temporaryPath, data, { flag: "wx" });
      try {
        accessSync(finalPath, constants.F_OK);
        await this.verifyFile(finalPath, { contentHash, byteSize: data.byteLength, mime, blobPath });
        rmSync(temporaryPath);
        return { contentHash, byteSize: data.byteLength, mime, blobPath, created: false };
      } catch (error) {
        if (error instanceof AttachmentStorageError) throw error;
      }
      const realRoot = realpathSync(this.root);
      const realParent = realpathSync(dirname(finalPath));
      if (!isContained(realRoot, realParent)) throw new AttachmentStorageError("path-rejected");
      this.rename(temporaryPath, finalPath);
      return { contentHash, byteSize: data.byteLength, mime, blobPath, created: true };
    } catch (cause) {
      rmSync(temporaryPath, { force: true });
      if (cause instanceof AttachmentStorageError) throw cause;
      throw new AttachmentStorageError("write-failed", { cause });
    }
  }

  async read(metadata: ImageBlobMetadata): Promise<Uint8Array> {
    const path = this.resolveBlobPath(metadata.blobPath);
    return this.verifyFile(path, metadata);
  }

  remove(blobPath: string): void {
    this.removeFile(this.resolveBlobPath(blobPath));
  }

  maintain(
    referencedBlobPaths: ReadonlySet<string>,
    options: AttachmentMaintenanceOptions = {},
  ): AttachmentFileMaintenanceReport {
    const now = options.now?.() ?? Date.now();
    const temporaryMaxAgeMs = options.temporaryMaxAgeMs ?? DEFAULT_TEMPORARY_MAX_AGE_MS;
    const fileSystemBefore = this.inventory();
    const removed: string[] = [];
    const failed: string[] = [];

    for (const blobPath of fileSystemBefore) {
      try {
        const absolutePath = this.resolveBlobPath(blobPath);
        const isExpiredPartial = blobPath.startsWith("images/.tmp/")
          && blobPath.endsWith(".partial")
          && now - statSync(absolutePath).mtimeMs >= temporaryMaxAgeMs;
        const isUnreferencedFinal = FINAL_BLOB_PATH.test(blobPath) && !referencedBlobPaths.has(blobPath);
        if (!isExpiredPartial && !isUnreferencedFinal) continue;
        this.removeFile(absolutePath);
        removed.push(blobPath);
      } catch {
        failed.push(blobPath);
      }
    }

    return { fileSystemBefore, fileSystemAfter: this.inventory(), removed, failed };
  }

  private inventory(): string[] {
    const paths: string[] = [];
    const visit = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) visit(path);
        else if (entry.isFile()) paths.push(relative(dirname(this.root), path));
      }
    };
    visit(this.root);
    return paths.sort();
  }

  private resolveBlobPath(blobPath: string): string {
    if (isAbsolute(blobPath)) throw new AttachmentStorageError("path-rejected");
    const path = resolve(dirname(this.root), blobPath);
    if (!isContained(this.root, path)) throw new AttachmentStorageError("path-rejected");
    return path;
  }

  private async verifyFile(path: string, metadata: ImageBlobMetadata): Promise<Uint8Array> {
    let data: Uint8Array;
    try {
      if (lstatSync(path).isSymbolicLink()) throw new AttachmentStorageError("path-rejected");
      const realPath = realpathSync(path);
      const realRoot = realpathSync(this.root);
      if (!isContained(realRoot, realPath)) throw new AttachmentStorageError("path-rejected");
      data = readFileSync(realPath);
    } catch (cause) {
      if (cause instanceof AttachmentStorageError) throw cause;
      const code = (cause as NodeJS.ErrnoException).code;
      throw new AttachmentStorageError(code === "ENOENT" ? "missing" : "corrupt", { cause });
    }

    if (data.byteLength !== metadata.byteSize) throw new AttachmentStorageError("corrupt");
    const hash = createHash("sha256").update(data).digest("hex");
    if (hash !== metadata.contentHash) throw new AttachmentStorageError("corrupt");
    if ((await decodedMime(data)) !== metadata.mime) throw new AttachmentStorageError("unsupported-media");
    return data;
  }
}
