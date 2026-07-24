import { LRUCache } from "lru-cache";

export const DEFAULT_PROJECTION_CACHE_CAPACITY = 32;

/**
 * Database-backed projections are expensive to reconstruct, but retaining one
 * for every historical conversation merely trades allocation churn for a
 * process-lifetime leak. This cache keeps only the most recently read streams
 * and advances a warm projection from its durable sequence cursor.
 */
export class IncrementalProjectionCache<TEvent, TProjection extends object> {
  private readonly entries: LRUCache<string, TProjection>;

  constructor(
    private readonly lastSequence: (projection: TProjection) => number,
    private readonly projectEvents: (events: readonly TEvent[], initial?: TProjection) => TProjection,
    capacity = DEFAULT_PROJECTION_CACHE_CAPACITY,
  ) {
    this.entries = new LRUCache({ max: capacity });
  }

  project(key: string, loadAfter: (sequence: number) => readonly TEvent[]): TProjection {
    const cached = this.entries.get(key);
    const events = loadAfter(cached ? this.lastSequence(cached) : 0);
    if (cached && events.length === 0) return cached;
    const projected = this.projectEvents(events, cached);
    this.entries.set(key, projected);
    return projected;
  }

  invalidate(key: string): void {
    this.entries.delete(key);
  }
}
