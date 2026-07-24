const DEFAULT_MAX_BUFFERED_EVENTS = 256;

export interface ReplayThenLiveOptions<TEvent> {
  after: number;
  sequence(event: TEvent): number;
  replay(after: number): readonly TEvent[];
  subscribe(listener: (event: TEvent) => void): () => void;
  write(event: TEvent): void | Promise<void>;
  terminal?(event: TEvent): boolean;
  maxBufferedEvents?: number;
  onClose?(): void;
}

/**
 * Shared replay-then-live coordinator for SSE-backed ordered logs.
 *
 * Subscribe happens before replay, live arrivals are buffered during replay,
 * and sequence deduplication closes the race between both sources. Replay is
 * written with backpressure and the live backlog is bounded. A disconnected
 * or slow subscriber is removed immediately, allowing it to reconnect from
 * its durable cursor without retaining the stream and its event payloads.
 */
export function replayThenLive<TEvent>(options: ReplayThenLiveOptions<TEvent>): {
  close(): Promise<void>;
} {
  const maxBufferedEvents = options.maxBufferedEvents ?? DEFAULT_MAX_BUFFERED_EVENTS;
  if (!Number.isInteger(maxBufferedEvents) || maxBufferedEvents < 1) {
    throw new Error("maxBufferedEvents must be a positive integer");
  }

  let replaying = true;
  let draining = true;
  let lastWritten = options.after;
  const pending: TEvent[] = [];
  let closed = false;
  let unsubscribe: (() => void) | undefined;
  let unsubscribeRequested = false;
  let unsubscribed = false;

  const unsubscribeNow = () => {
    if (unsubscribed) return;
    if (!unsubscribe) {
      unsubscribeRequested = true;
      return;
    }
    unsubscribed = true;
    unsubscribe();
  };
  const close = async (): Promise<void> => {
    if (!closed) {
      closed = true;
      pending.length = 0;
      unsubscribeNow();
      options.onClose?.();
    }
  };

  const write = async (event: TEvent): Promise<void> => {
    const sequence = options.sequence(event);
    if (closed || sequence <= lastWritten) return;
    lastWritten = sequence;
    await options.write(event);
    if (!closed && options.terminal?.(event)) await close();
  };

  const drain = async (): Promise<void> => {
    if (closed) return;
    draining = true;
    try {
      while (!closed && pending.length > 0) await write(pending.shift()!);
    } catch {
      await close();
    } finally {
      draining = false;
    }
  };

  const buffer = (event: TEvent) => {
    if (closed || options.sequence(event) <= lastWritten) return;
    if (pending.length >= maxBufferedEvents) {
      void close();
      return;
    }
    pending.push(event);
    if (!replaying && !draining) void drain();
  };

  unsubscribe = options.subscribe(buffer);
  if (unsubscribeRequested) unsubscribeNow();

  let replay: readonly TEvent[];
  try {
    replay = options.replay(lastWritten);
  } catch (error) {
    void close();
    throw error;
  }

  void (async () => {
    try {
      for (const event of replay) {
        if (closed) break;
        await write(event);
      }
      replaying = false;
      pending.sort((left, right) => options.sequence(left) - options.sequence(right));
      while (!closed && pending.length > 0) await write(pending.shift()!);
    } catch {
      await close();
    } finally {
      replaying = false;
      draining = false;
      if (!closed && pending.length > 0) void drain();
    }
  })();

  return { close };
}
