import { cn } from "@/lib/utils";
import type { GateSummary } from "@/agent/gateSummary";

export interface VerificationChipProps {
  streaming: boolean;
  summary: GateSummary | undefined;
}

/** Session-level verification status chip for the chat header.
 * Copy rule: states what was checked ("n/n checks"), never "correct" —
 * the gate verifies the agent's declared plan, not the user's intent. */
export function VerificationChip({ streaming, summary }: VerificationChipProps) {
  const state = streaming ? "verifying" : summary?.status;
  if (!state) return null;

  const label =
    state === "verifying"
      ? "Verifying…"
      : state === "passed"
        ? `Verified · ${summary?.passedChecks}/${summary?.totalChecks} checks`
        : state === "failed"
          ? "Gate failed"
          : "Unverified";

  return (
    <span
      data-testid="verify-chip"
      data-status={state}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium",
        state === "verifying" && "border-amber-300 bg-amber-50 text-amber-700",
        state === "passed" && "border-emerald-300 bg-emerald-50 text-emerald-700",
        state === "failed" && "border-red-300 bg-red-50 text-red-700",
        state === "error" && "border-border bg-muted text-muted-foreground",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          state === "verifying" && "animate-pulse bg-amber-500 motion-reduce:animate-none",
          state === "passed" && "bg-emerald-500",
          state === "failed" && "bg-red-500",
          state === "error" && "bg-muted-foreground",
        )}
      />
      {label}
    </span>
  );
}
