import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";

/**
 * Transparent transient-failure retry for a pi StreamFn. Rate-limit, overload, and
 * transport failures are retried with backoff instead of erroring the turn.
 *
 * A retry after content has streamed suppresses the new attempt's `start` event. Every
 * later content event carries that attempt's complete partial message, so pi-agent-core
 * replaces the interrupted partial in place and still persists only the final attempt.
 */

export const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BASE_DELAY_MS = 2_000;
const DEFAULT_MAX_DELAY_MS = 60_000;

// Deliberately narrower than session.ts's error classification: only failures that are
// transient by definition are worth retrying. Auth and request-shape errors would fail
// identically on every attempt.
const RETRYABLE_PATTERN =
  /\b429\b|\b529\b|rate[ _-]?limit|too many requests|overloaded|network (?:error|failure)|failed to fetch|fetch failed|\b(?:econnreset|econnrefused|etimedout|epipe)\b|socket hang up|connection (?:reset|closed|terminated)|stream (?:ended|terminated|disconnected)/i;

export interface RetryWaitInfo {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
}

export interface StreamRetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Called before each backoff wait; feeds the "rate-limited, retrying" UI status. */
  onWait?: (info: RetryWaitInfo) => void;
  /** Called when a backoff wait ends and the next attempt starts. */
  onResume?: () => void;
  /** Test seam for the backoff wait. */
  sleep?: (ms: number) => Promise<void>;
}

export function isRetryableFailure(errorMessage: string | undefined): boolean {
  return typeof errorMessage === "string" && RETRYABLE_PATTERN.test(errorMessage);
}

/** Server-hinted retry delay when present ("retry-after: 12", "retryAfter":12), else exponential backoff with jitter. */
export function retryDelayMs(
  errorMessage: string,
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
): number {
  const hinted = /retry[-_ ]?after["':\s]*(\d+(?:\.\d+)?)/i.exec(errorMessage);
  if (hinted) {
    const seconds = Number(hinted[1]);
    if (Number.isFinite(seconds) && seconds > 0) return Math.min(Math.round(seconds * 1000), maxDelayMs);
  }
  const exponential = baseDelayMs * 2 ** (attempt - 1);
  const jitter = 0.8 + Math.random() * 0.4;
  return Math.min(Math.round(exponential * jitter), maxDelayMs);
}

function syntheticFailure(reason: string, aborted: boolean): AssistantMessageEvent {
  const stopReason = aborted ? "aborted" : "error";
  const message = {
    role: "assistant",
    content: [],
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    errorMessage: reason,
    timestamp: Date.now(),
  } as unknown as AssistantMessage;
  return { type: "error", reason: stopReason, error: message };
}

export function withStreamRetry(base: StreamFn, retryOptions: StreamRetryOptions = {}): StreamFn {
  const maxAttempts = retryOptions.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseDelayMs = retryOptions.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = retryOptions.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const sleep = retryOptions.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  return (model, context, options) => {
    const out = createAssistantMessageEventStream();
    void (async () => {
      let streamStarted = false;
      for (let attempt = 1; ; attempt += 1) {
        // Hold each attempt's start until real content arrives. The first productive
        // attempt starts the assistant message; later attempts update that same partial.
        let heldStart: AssistantMessageEvent | undefined;
        let terminal: AssistantMessageEvent | undefined;

        const inner = await base(model, context, options);
        for await (const event of inner) {
          if (event.type === "done" || event.type === "error") {
            terminal = event;
            break;
          }
          if (event.type === "start") {
            heldStart = event;
            continue;
          }
          if (!streamStarted) {
            streamStarted = true;
            if (heldStart) out.push(heldStart);
          }
          out.push(event);
        }

        const failure =
          terminal?.type === "error" && terminal.reason === "error" ? terminal.error : undefined;
        if (
          failure &&
          attempt < maxAttempts &&
          isRetryableFailure(failure.errorMessage) &&
          !options?.signal?.aborted
        ) {
          const delayMs = retryDelayMs(failure.errorMessage ?? "", attempt, baseDelayMs, maxDelayMs);
          retryOptions.onWait?.({ attempt, maxAttempts, delayMs });
          await sleep(delayMs);
          retryOptions.onResume?.();
          if (!options?.signal?.aborted) continue;
          // Aborted mid-wait: give up and surface the original failure below.
        }

        if (!streamStarted && heldStart) out.push(heldStart);
        out.push(terminal ?? syntheticFailure("stream ended without a terminal event", false));
        return;
      }
    })().catch((error: unknown) => {
      // StreamFn contract: failures must be encoded in the stream, never thrown. A
      // rejection after the caller aborted (streamProxy rejects with the signal's
      // reason) must keep its "aborted" shape so the session does not show an error.
      out.push(
        syntheticFailure(
          error instanceof Error ? error.message : String(error),
          Boolean(options?.signal?.aborted),
        ),
      );
    });
    return out;
  };
}
