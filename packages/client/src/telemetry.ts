// Client error reporting. Sentry loads only when VITE_SENTRY_DSN is set (the
// hosted online build), so local and self-hosted bundles neither ship nor call
// it: the dynamic import is a separate chunk Vite never fetches without a DSN,
// and every exported function no-ops until initTelemetry has resolved.

type SentryModule = typeof import("@sentry/react");

let sentry: SentryModule | null = null;

export async function initTelemetry(): Promise<void> {
  const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;
  if (!dsn) return;
  const mod = await import("@sentry/react");
  mod.init({
    dsn,
    environment: import.meta.env.VITE_SENTRY_ENVIRONMENT as string | undefined,
    release: import.meta.env.VITE_CHAMFER_RELEASE as string | undefined,
    // Global handlers Sentry.init installs cover unhandled errors and rejections;
    // captureError below adds the handled failures worth knowing about.
    tracesSampleRate: 0.1,
  });
  sentry = mod;
}

/** Report an error we caught and handled (so it never reaches a global handler)
 * but that still signals something broken - a failed startup fetch, a 5xx. */
export function captureError(error: unknown, context?: Record<string, unknown>): void {
  if (!sentry) return;
  sentry.captureException(error, context ? { extra: context } : undefined);
}
