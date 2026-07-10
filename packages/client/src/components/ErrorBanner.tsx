import { X } from "lucide-react";
import type { SessionError } from "@/agent/session";
import { Button } from "@/components/ui/button";

export interface ErrorBannerProps {
  error: SessionError;
  /** Opens the settings modal; the Open Settings action renders only when provided. */
  onOpenSettings?: () => void;
  /** Re-sends the last user message; the Retry action renders only when provided. */
  onRetry?: () => void;
  /** Clears the error; the dismiss X renders only when provided. */
  onDismiss?: () => void;
}

/**
 * Error strip above the message list, rendered by SessionError kind:
 * - "invalid-key": actionable hint plus an Open Settings button.
 * - "rate-limited": the raw message plus a Retry button re-sending the last user message.
 * - "generic": the raw message text.
 * An optional dismiss X (onDismiss) appears after the kind-specific content.
 */
export function ErrorBanner({ error, onOpenSettings, onRetry, onDismiss }: ErrorBannerProps) {
  return (
    <div
      data-testid="error-banner"
      className="flex shrink-0 items-center gap-3 border-b bg-destructive/10 px-4 py-2 text-sm text-destructive"
    >
      {error.kind === "invalid-key" ? (
        <>
          <span className="min-w-0 flex-1">Check your API key in Settings</span>
          {onOpenSettings && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid="error-open-settings"
              onClick={onOpenSettings}
            >
              Open Settings
            </Button>
          )}
        </>
      ) : error.kind === "rate-limited" ? (
        <>
          <span className="min-w-0 flex-1 break-words">{error.message}</span>
          {onRetry && (
            <Button type="button" size="sm" variant="outline" data-testid="error-retry" onClick={onRetry}>
              Retry
            </Button>
          )}
        </>
      ) : (
        <span className="min-w-0 flex-1 break-words">{error.message}</span>
      )}
      {onDismiss && (
        <button
          type="button"
          aria-label="Dismiss error"
          data-testid="error-dismiss"
          onClick={onDismiss}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded hover:bg-destructive/10"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
