import type { FusionReadinessDto, FusionReadinessState } from "@chamfer/shared";
import { cn } from "@/lib/utils";

const STATE_COLOR: Record<FusionReadinessState, string> = {
  unavailable: "bg-slate-400", incompatible: "bg-red-500", "no-document": "bg-amber-500",
  "wrong-document": "bg-red-500", "read-only": "bg-amber-500", busy: "bg-blue-500",
  unsupported: "bg-amber-500", degraded: "bg-red-500", ready: "bg-emerald-500",
};

export function FusionReadinessBadge({ readiness, showDiagnosis = false, className }: { readiness?: FusionReadinessDto; showDiagnosis?: boolean; className?: string }) {
  const state = readiness?.state ?? "unavailable";
  return (
    <span role="status" data-state={state} className={cn("inline-flex min-w-0 items-center gap-2", className)}>
      <span className={cn("h-2 w-2 shrink-0 rounded-full", STATE_COLOR[state])} aria-hidden="true" />
      <span className="font-medium">{readiness?.label ?? "Checking"}</span>
      {showDiagnosis && <span className="min-w-0 text-muted-foreground">{readiness?.diagnosis ?? "Checking the local Fusion connection…"}</span>}
    </span>
  );
}
