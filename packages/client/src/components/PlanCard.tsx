import { useState } from "react";
import { AlertTriangle, Ban, Check, ChevronDown, ChevronRight, Circle, FileText, Hammer, Link2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Plan, PlanComponent } from "@/agent/plan";

function StatusIcon({ status }: { status: PlanComponent["status"] }) {
  if (status === "done") return <Check className="h-3 w-3 text-emerald-600" aria-hidden="true" />;
  if (status === "building")
    return <Hammer className="h-3 w-3 animate-pulse text-amber-600 motion-reduce:animate-none" aria-hidden="true" />;
  if (status === "abandoned") return <Ban className="h-3 w-3 text-muted-foreground" aria-hidden="true" />;
  return <Circle className="h-3 w-3 text-muted-foreground" aria-hidden="true" />;
}

export interface PlanCardProps {
  plan: Plan;
}

/**
 * Live rendering of the plan of record (the newest accepted update_plan snapshot).
 * Collapsed by default to a one-line progress strip; expands to the component list
 * with statuses, abandon reasons, and the interfaces holding the assembly together.
 */
export function PlanCard({ plan }: PlanCardProps) {
  const [expanded, setExpanded] = useState(false);
  const doneCount = plan.components.filter((c) => c.status === "done").length;
  const activeCount = plan.components.filter((c) => c.status !== "abandoned").length;

  return (
    <div data-testid="plan-card" className="shrink-0 border-b bg-muted/20 px-4 py-1.5 text-xs">
      <button
        type="button"
        data-testid="plan-card-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-1.5 text-left text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3 shrink-0" aria-hidden="true" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0" aria-hidden="true" />
        )}
        <span className="font-medium text-foreground">Plan</span>
        <span data-testid="plan-progress" className="tabular-nums">
          {doneCount}/{activeCount} components
        </span>
        <span className="min-w-0 flex-1 truncate">{plan.goal}</span>
      </button>
      {expanded && (
        <div className="mt-1.5 flex flex-col gap-1 pb-1 pl-4.5">
          {plan.components.map((component) => (
            <div key={component.id}>
              <div
                data-testid="plan-component"
                data-status={component.status}
                className={cn(
                  "flex min-w-0 items-center gap-1.5",
                  component.status === "abandoned" && "text-muted-foreground line-through",
                )}
              >
                <StatusIcon status={component.status} />
                <span className="font-mono">{component.id}</span>
                <span className="min-w-0 truncate text-muted-foreground">{component.description}</span>
                {component.status === "abandoned" && component.abandon_reason && (
                  <span data-testid="plan-abandon-reason" className="min-w-0 truncate no-underline">
                    - {component.abandon_reason}
                  </span>
                )}
              </div>
              {(component.checks ?? []).length > 0 && (
                <div className="ml-4.5 mt-0.5 flex flex-wrap gap-1">
                  {(component.checks ?? []).map((check, checkIndex) => (
                    <span
                      key={checkIndex}
                      id={`plan-check-${component.id}-${checkIndex}`}
                      className="rounded border bg-background px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                    >
                      {check.kind}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
          {(plan.interfaces ?? []).length > 0 && (
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-muted-foreground">
              <Link2 className="h-3 w-3" aria-hidden="true" />
              {plan.interfaces.map((iface, index) => (
                <span key={index} data-testid="plan-interface" className="font-mono">
                  {iface.a}·{iface.b} {iface.kind === "captive" ? "captive" : `≥${iface.min_mm ?? 0}mm`}
                  {iface.kind === "clearance" && iface.max_mm !== undefined ? `≤${iface.max_mm}mm` : ""}
                </span>
              ))}
            </div>
          )}
          {(plan.spec_sheet ?? []).length > 0 && (
            <div className="mt-1.5 border-t pt-1.5" data-testid="plan-spec-sheet">
              <div className="mb-1 flex items-center gap-1 font-medium text-foreground">
                <FileText className="h-3 w-3" aria-hidden="true" />
                <span>Spec sheet</span>
              </div>
              <div className="flex flex-col gap-1">
                {(plan.spec_sheet ?? []).map((row) => {
                  const unverifiable = Boolean(row.unverifiable_reason?.trim());
                  return (
                    <div
                      key={row.id}
                      data-testid="plan-spec-row"
                      className={cn(
                        "flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 border-l-2 border-emerald-400 bg-emerald-50/60 px-2 py-1 text-foreground dark:bg-emerald-950/20",
                        unverifiable &&
                          "border-amber-400 bg-amber-50 text-amber-950 dark:bg-amber-950/30 dark:text-amber-100",
                      )}
                    >
                      <span className="min-w-0 flex-1">{row.text}</span>
                      {(row.check_refs ?? []).map((ref, refIndex) => (
                        <a
                          key={`${ref.component_id}-${ref.check_index}-${refIndex}`}
                          data-testid="plan-spec-check-link"
                          href={`#plan-check-${ref.component_id}-${ref.check_index}`}
                          className="inline-flex items-center gap-1 font-mono text-emerald-700 underline decoration-dotted underline-offset-2 hover:text-emerald-900 dark:text-emerald-300"
                        >
                          <Link2 className="h-3 w-3" aria-hidden="true" />
                          {ref.component_id} check {ref.check_index + 1}
                        </a>
                      ))}
                      {unverifiable && (
                        <span
                          data-testid="plan-spec-unverifiable"
                          className="inline-flex items-center gap-1 rounded border border-amber-400 bg-amber-50 px-1.5 py-0.5 text-amber-800 dark:bg-amber-950 dark:text-amber-200"
                        >
                          <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                          <span className="font-medium">Unverifiable:</span>
                          {row.unverifiable_reason}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
