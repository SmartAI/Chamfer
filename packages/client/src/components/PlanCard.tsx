import { useState } from "react";
import { AlertOctagon, AlertTriangle, Ban, Check, ChevronDown, ChevronRight, Circle, FileText, Hammer, History, Link2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Plan, PlanComponent } from "@/agent/plan";
import type { SourceSpecificationDto } from "@chamfer/shared";

function StatusIcon({ status }: { status: PlanComponent["status"] }) {
  if (status === "done") return <Check className="h-3 w-3 text-emerald-600" aria-hidden="true" />;
  if (status === "building")
    return <Hammer className="h-3 w-3 animate-pulse text-amber-600 motion-reduce:animate-none" aria-hidden="true" />;
  if (status === "blocked") return <AlertOctagon className="h-3 w-3 text-red-600" aria-hidden="true" />;
  if (status === "abandoned") return <Ban className="h-3 w-3 text-muted-foreground" aria-hidden="true" />;
  return <Circle className="h-3 w-3 text-muted-foreground" aria-hidden="true" />;
}

export interface PlanCardProps {
  plan: Plan;
  sourceSpecifications?: readonly SourceSpecificationDto[];
}

/**
 * Live rendering of the newest accepted legacy or operation-backed plan.
 * Collapsed by default to a one-line progress strip; expands to the component list
 * with statuses, abandon reasons, and the interfaces holding the assembly together.
 */
export function PlanCard({ plan, sourceSpecifications = [] }: PlanCardProps) {
  const [expanded, setExpanded] = useState(false);
  const currentComponents = plan.domain
    ? plan.components.filter((component) => component.retired_revision === undefined && component.status !== "abandoned")
    : plan.components;
  const currentInterfaces = plan.domain
    ? (plan.interfaces ?? []).filter((planInterface) => planInterface.retired_revision === undefined)
    : (plan.interfaces ?? []);
  const doneCount = currentComponents.filter((component) => component.status === "done").length;
  const activeCount = currentComponents.filter((component) => component.status !== "abandoned").length;
  const activeSourceIds = sourceSpecifications
    .filter((specification) => specification.status === "active")
    .map((specification) => specification.id);
  const coveredSourceIds = plan.domain?.source_specification_ids ?? [];
  const currentCoverage = activeSourceIds.filter((id) => coveredSourceIds.includes(id)).length;
  const sourceCoverageCurrent = Boolean(plan.domain) && currentCoverage === activeSourceIds.length &&
    coveredSourceIds.length === activeSourceIds.length;

  return (
    <div
      data-testid="plan-card"
      data-plan-format={plan.domain?.format ?? "legacy-snapshot"}
      className="shrink-0 border-b bg-muted/20 px-4 py-1.5 text-xs"
    >
      <button
        type="button"
        data-testid="plan-card-toggle"
        aria-expanded={expanded}
        aria-controls="plan-card-contents"
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
        {plan.domain && (
          <span data-testid="plan-revision" className="shrink-0 tabular-nums text-muted-foreground">
            Revision {plan.domain.revision} · criteria {plan.domain.criteria_revision}
          </span>
        )}
        {plan.domain && activeSourceIds.length > 0 && (
          <span
            data-testid="plan-source-coverage"
            data-current={sourceCoverageCurrent ? "true" : "false"}
            className={cn("shrink-0 tabular-nums", sourceCoverageCurrent ? "text-emerald-700 dark:text-emerald-300" : "text-red-700 dark:text-red-300")}
          >
            {currentCoverage}/{activeSourceIds.length} source requirements {sourceCoverageCurrent ? "current" : "stale"}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate">{plan.goal}</span>
      </button>
      {expanded && (
        <div
          id="plan-card-contents"
          data-testid="plan-card-contents"
          className="mt-1.5 flex max-h-[min(40vh,24rem)] flex-col gap-1 overflow-y-auto overscroll-contain pb-1 pl-4.5"
        >
          {currentComponents.map((component) => (
            <div key={component.id}>
              <div
                data-testid="plan-component"
                data-status={component.status}
                data-entity-id={component.id}
                data-criteria-revision={component.criteria_revision}
                className={cn(
                  "flex min-w-0 items-center gap-1.5",
                  component.status === "abandoned" && "text-muted-foreground line-through",
                  component.status === "blocked" && "text-red-800 dark:text-red-200",
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
                {component.status === "blocked" && component.blocked_reason && (
                  <span data-testid="plan-blocked-reason" className="min-w-0 truncate font-medium text-red-700 dark:text-red-300">
                    - Blocked: {component.blocked_reason}
                  </span>
                )}
              </div>
              {(component.checks ?? []).filter((check) => !plan.domain || (!(check as { retired_revision?: number }).retired_revision && !check.removed)).length > 0 && (
                <div className="ml-4.5 mt-0.5 flex flex-wrap gap-1">
                  {(component.checks ?? []).filter((check) => !plan.domain || ((check as { retired_revision?: number }).retired_revision === undefined && !check.removed)).map((check, checkIndex) => {
                    // Snapshots persisted before stable check ids anchor by position.
                    const checkId = (check as { id?: string }).id ?? checkIndex;
                    return (
                      <span
                        key={checkId}
                        id={`plan-check-${component.id}-${checkId}`}
                        data-testid={!plan.domain && check.revision_reason ? "plan-check-revision" : undefined}
                        className={cn(
                          "rounded border bg-background px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground",
                          check.removed && "line-through",
                          !plan.domain && check.revision_reason && "border-amber-400 bg-amber-50 text-amber-900 dark:bg-amber-950/30 dark:text-amber-100",
                        )}
                      >
                        {check.kind}
                        {check.removed ? " (removed)" : ""}
                        {!plan.domain && check.revision_reason ? ` - Revised: ${check.revision_reason}` : ""}
                        {!plan.domain && check.refit_to_measurement ? " - Refit to latest measurement" : ""}
                      </span>
                    );
                  })}
                </div>
              )}
              {component.form_review && (
                <div className="ml-4.5 mt-1 flex flex-col gap-0.5 border-l-2 border-emerald-400 pl-2" data-testid="plan-form-review">
                  <span className="font-medium text-foreground">Form review</span>
                  {component.form_review.views.map((entry) => (
                    <div
                      key={entry.view}
                      data-testid="plan-form-review-verdict"
                      className={cn(
                        "flex gap-1.5",
                        entry.verdict === "match" ? "text-emerald-700 dark:text-emerald-300" : "text-red-700 dark:text-red-300",
                      )}
                    >
                      <span className="w-14 shrink-0 font-mono">{entry.view}</span>
                      <span className="shrink-0 font-medium">{entry.verdict}</span>
                      <span className="text-muted-foreground">- {entry.note}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
          {currentInterfaces.length > 0 && (
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-muted-foreground">
              <Link2 className="h-3 w-3" aria-hidden="true" />
              {currentInterfaces.map((iface, index) => (
                <span
                  key={iface.entity_id ?? index}
                  data-testid="plan-interface"
                  data-entity-id={iface.entity_id}
                  data-retired={iface.retired_revision === undefined ? undefined : "true"}
                  className={cn("font-mono", iface.retired_revision !== undefined && "line-through")}
                >
                  {iface.a}·{iface.b} {iface.kind === "captive" ? "captive" : `≥${iface.min_mm ?? 0}mm`}
                  {iface.kind === "clearance" && iface.max_mm !== undefined ? `≤${iface.max_mm}mm` : ""}
                  {iface.retired_revision !== undefined ? " (retired)" : ""}
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
                      {(row.check_refs ?? []).map((ref, refIndex) => {
                        // Legacy refs (pre check-id snapshots) carry check_index instead.
                        const legacy = ref as { component_id: string; check_id?: string; check_index?: number };
                        const anchor = legacy.check_id ?? legacy.check_index ?? 0;
                        const label = legacy.check_id ?? `check ${(legacy.check_index ?? 0) + 1}`;
                        return (
                          <a
                            key={`${ref.component_id}-${anchor}-${refIndex}`}
                            data-testid="plan-spec-check-link"
                            href={`#plan-check-${ref.component_id}-${anchor}`}
                            className="inline-flex items-center gap-1 font-mono text-emerald-700 underline decoration-dotted underline-offset-2 hover:text-emerald-900 dark:text-emerald-300"
                          >
                            <Link2 className="h-3 w-3" aria-hidden="true" />
                            {ref.component_id} {label}
                          </a>
                        );
                      })}
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
                      {row.revision_reason && (
                        <span
                          data-testid="plan-spec-revision"
                          className="inline-flex items-center rounded border border-amber-400 bg-amber-50 px-1.5 py-0.5 text-amber-900 dark:bg-amber-950 dark:text-amber-100"
                        >
                          Revised: {row.revision_reason}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          {plan.domain && plan.domain.history.length > 0 && (
            <div className="mt-1.5 border-t pt-1.5" data-testid="plan-history">
              <div className="mb-1 flex items-center gap-1 font-medium text-foreground">
                <History className="h-3 w-3" aria-hidden="true" />
                <span>Immutable history</span>
              </div>
              <div className="flex flex-col gap-1 text-muted-foreground">
                {plan.domain.history.map((entry) => (
                  <div key={entry.mutation_id} data-testid="plan-history-entry" className="flex min-w-0 gap-2">
                    <span className="shrink-0 font-mono">r{entry.revision} · c{entry.criteria_revision}</span>
                    <span className="min-w-0">{entry.reason}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
