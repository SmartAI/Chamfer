import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Contracted relative export path inside the conversation's sandbox cwd; the
 * build123d system prompt instructs the agent to export here after changes. */
export const ARTIFACT_FILENAME = "artifact.stl";

/** Per-conversation agent working directory under the data dir; the session's
 * sandbox cwd and the local store's served export location share this layout. */
export function conversationAgentDir(dataDir: string, conversationId: string): string {
  return join(dataDir, "agent", conversationId);
}

/** One observation of the contracted export in a conversation cwd, taken by
 * the session host (which owns the turn's filesystem) and handed to record().
 * Backends that keep the observed file in place never call bytes(). */
export interface ArtifactExport {
  /** Millisecond mtime at observation time: the rewrite signal a store turns
   * into its own revision. */
  mtimeMs: number;
  bytes(): Promise<Uint8Array>;
}

export interface ArtifactRecord {
  /** Store-owned revision: changes on every recorded rewrite and holds steady
   * across no-op records. Monotonic under a monotonic rewrite signal (the
   * local backend derives it from the export's mtime, so a clock regression
   * can lower it; callers rely on change detection, not ordering). */
  revision: number;
  /** True when this record observed a rewrite since the previous record for
   * the conversation (including the first record a store instance sees). */
  updated: boolean;
}

export interface CurrentArtifact {
  revision: number;
  /** Rejects when the stored copy is gone (e.g. deleted between checks). */
  bytes(): Promise<Uint8Array>;
}

/** Owns the artifact revision contract behind the agent's export: record()
 * ingests the conversation's export at turn end, current() serves the latest
 * copy to the artifact route. How a backend derives revisions - file mtimes
 * locally, a persisted counter on R2 - is its own detail; callers rely only
 * on monotonic-per-rewrite. */
export interface ArtifactStore {
  record(conversationId: string, exportFile: ArtifactExport): Promise<ArtifactRecord>;
  current(conversationId: string): Promise<CurrentArtifact | undefined>;
  /** Whether the conversation has a current export, without materializing its
   * bytes. The conversation list calls this per row to flag produced models, so
   * backends answer it as cheaply as they can (a stat locally, a metadata HEAD
   * on R2) rather than fetching the object. */
  exists(conversationId: string): Promise<boolean>;
}

/** Observes the contracted export inside a conversation dir; undefined until
 * the agent has exported. */
export function observeExport(conversationDir: string): ArtifactExport | undefined {
  const path = join(conversationDir, ARTIFACT_FILENAME);
  try {
    const { mtimeMs } = statSync(path);
    return { mtimeMs, bytes: () => readFile(path) };
  } catch {
    return undefined;
  }
}

/** Local filesystem backend: the export file in the conversation cwd IS the
 * store, so record() is pure revision bookkeeping (no copy) and current()
 * serves the file in place. Revision = the export's mtime floored to whole
 * milliseconds - monotonic because every rewrite lands at a later mtime, and
 * stable across server restarts so viewer ETags keep matching. */
export class LocalArtifactStore implements ArtifactStore {
  /** Last recorded revision per conversation. In-memory only: a restart
   * re-derives the same revision from the same mtime, so nothing is lost. */
  private readonly recorded = new Map<string, number>();

  constructor(private readonly dataDir: string) {}

  record(conversationId: string, exportFile: ArtifactExport): Promise<ArtifactRecord> {
    const revision = Math.floor(exportFile.mtimeMs);
    const updated = this.recorded.get(conversationId) !== revision;
    this.recorded.set(conversationId, revision);
    return Promise.resolve({ revision, updated });
  }

  current(conversationId: string): Promise<CurrentArtifact | undefined> {
    const exportFile = observeExport(conversationAgentDir(this.dataDir, conversationId));
    if (!exportFile) return Promise.resolve(undefined);
    return Promise.resolve({ revision: Math.floor(exportFile.mtimeMs), bytes: exportFile.bytes });
  }

  exists(conversationId: string): Promise<boolean> {
    return Promise.resolve(observeExport(conversationAgentDir(this.dataDir, conversationId)) !== undefined);
  }
}
