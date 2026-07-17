import { cn } from "@/lib/utils";
import type { GateSummary } from "@/agent/gateSummary";
import type { ProofEvidenceState, VisualVerificationRecordDto } from "@chamfer/shared";

export interface VerificationChipProps {
  streaming: boolean;
  summary: GateSummary | undefined;
  visual?: VisualVerificationRecordDto;
  proofState?: Exclude<ProofEvidenceState, "not-applicable">;
}

/** Session-level verification status chip for the chat header.
 * Copy rule: states what was checked ("n/n checks"), never "correct" —
 * the gate verifies the agent's declared plan, not the user's intent. */
export function VerificationChip({ streaming, summary, visual, proofState }: VerificationChipProps) {
  const state = streaming ? "verifying" : summary?.status;
  if (!state && !visual && !proofState) return null;

  const label =
    state === "verifying"
      ? "Verifying…"
      : state === "passed"
        ? `Verified · ${summary?.passedChecks}/${summary?.totalChecks} checks`
        : state === "failed"
          ? "Gate failed"
          : "Unverified";

  return (
    <span className="flex min-w-0 items-center gap-1 overflow-hidden">
    {proofState && (
      <span
        data-testid="proof-status-chip"
        data-status={proofState}
        className={cn(
          "inline-flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium",
          proofState === "proven"
            ? "border-emerald-400 bg-emerald-100 text-emerald-800"
            : proofState === "failed"
              ? "border-red-300 bg-red-50 text-red-700"
              : "border-slate-300 bg-slate-50 text-slate-700",
        )}
      >
        <span aria-hidden="true" className={cn(
          "h-1.5 w-1.5 rounded-full",
          proofState === "proven" ? "bg-emerald-600" : proofState === "failed" ? "bg-red-500" : "bg-slate-500",
        )} />
        {proofState === "proven" ? "Proven" : `Proof ${proofState}`}
      </span>
    )}
    {state && (streaming || !proofState) && <span
      data-testid="verify-chip"
      data-status={state}
      className={cn(
        "inline-flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium",
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
    </span>}
    {visual && proofState !== "proven" && (
      <span
        data-testid="visual-verify-chip"
        data-verdict={visual.verdict}
        className={cn(
          "inline-flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium",
          visual.verdict === "match"
            ? "border-emerald-300 bg-emerald-50 text-emerald-700"
            : "border-red-300 bg-red-50 text-red-700",
        )}
      >
        <span aria-hidden="true" className={cn("h-1.5 w-1.5 rounded-full", visual.verdict === "match" ? "bg-emerald-500" : "bg-red-500")} />
        {visual.verdict === "match" ? "Visual match" : "Visual revision needed"} · {visual.coveredReferenceIds.length} refs
      </span>
    )}
    </span>
  );
}
