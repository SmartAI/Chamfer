import { CircleHelp, CheckCircle2 } from "lucide-react";
import type { DesignEscalationDto } from "@chamfer/shared";

export function DesignEscalationCard({ escalation }: { escalation: DesignEscalationDto }) {
  const pending = escalation.status === "pending";
  return (
    <section
      data-testid="design-escalation-card"
      data-status={escalation.status}
      className={pending
        ? "shrink-0 border-b border-amber-300 bg-amber-50 px-4 py-2 text-xs text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100"
        : "shrink-0 border-b border-emerald-200 bg-emerald-50/70 px-4 py-1.5 text-xs text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/20 dark:text-emerald-100"}
    >
      <div className="flex items-start gap-2">
        {pending
          ? <CircleHelp className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          : <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />}
        <div className="min-w-0">
          <div className="font-medium">{pending ? "One decision needs your input" : "Design clarification resolved"}</div>
          <div data-testid="design-escalation-question" className="mt-0.5 text-sm font-medium">
            {escalation.question}
          </div>
          <div className="mt-0.5 text-[10px] opacity-75">
            {pending ? escalation.basis : `New source evidence: ${escalation.resolutionSpecificationIds.join(", ")}`}
          </div>
        </div>
      </div>
    </section>
  );
}
