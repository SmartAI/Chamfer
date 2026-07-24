/** Storage-agnostic image blob contract.
 *
 * Kept free of node/sharp imports on purpose: the online Worker bundles every
 * consumer of these types, and an import of the filesystem-backed
 * attachmentStore module would execute sharp's native loader on workerd.
 * attachmentStore.ts re-exports everything here, so both stores share one
 * error and metadata vocabulary.
 */

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

/** The store surface routes and stores depend on. Local runs use the
 * filesystem-backed AttachmentStore; the online worker substitutes an R2
 * object-storage implementation, so depend on this instead of a class.
 * remove/maintain admit promises because object storage is asynchronous;
 * callers must await them. */
export interface ImageBlobStore {
  write(data: Uint8Array, declaredMime: string): Promise<StoredImageBlob>;
  read(metadata: ImageBlobMetadata): Promise<Uint8Array>;
  remove(blobPath: string): void | Promise<void>;
  maintain(
    referencedBlobPaths: ReadonlySet<string>,
    options?: AttachmentMaintenanceOptions,
  ): AttachmentFileMaintenanceReport | Promise<AttachmentFileMaintenanceReport>;
}
