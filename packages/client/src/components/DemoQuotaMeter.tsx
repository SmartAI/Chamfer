import type { OnlineBudgetDto } from "@chamfer/shared";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface DemoQuotaMeterProps {
  /** This account's free-demo dollar balance from GET /api/online/budget. */
  budget: OnlineBudgetDto;
  /** Opens Settings so an exhausted user can add their own API key. */
  onOpenSettings?: () => void;
}

function formatUsd(value: number): string {
  return `$${Math.max(0, value).toFixed(2)}`;
}

/**
 * The free-demo credit meter for the hosted deployment. While credit remains it
 * is a quiet one-line gauge (spent vs cap); once exhausted it becomes an amber
 * prompt steering the user to bring their own key - the only way to keep going.
 * Renders nothing when the deployment reports no cap (defensive; the caller
 * already gates on demo quota being present).
 */
export function DemoQuotaMeter({ budget, onOpenSettings }: DemoQuotaMeterProps) {
  if (budget.capUsd <= 0) return null;
  const remaining = Math.max(0, budget.capUsd - budget.spentUsd);
  const usedFraction = Math.min(1, Math.max(0, budget.spentUsd / budget.capUsd));
  const exhausted = remaining <= 0;

  if (exhausted) {
    return (
      <div
        data-testid="demo-quota-exhausted"
        role="status"
        className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-t border-amber-200 bg-amber-50 px-4 py-2 text-xs leading-relaxed text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
      >
        <span className="font-medium">Your free demo credit is used up.</span>
        <span>Add your own API key to keep building.</span>
        {onOpenSettings && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="demo-quota-add-key"
            className="ml-auto h-6 border-amber-300 bg-amber-100 px-2 text-amber-900 hover:bg-amber-200 dark:border-amber-800 dark:bg-amber-900 dark:text-amber-100 dark:hover:bg-amber-800"
            onClick={onOpenSettings}
          >
            Add API key
          </Button>
        )}
      </div>
    );
  }

  const low = usedFraction >= 0.8;
  return (
    <div
      data-testid="demo-quota-meter"
      className="flex shrink-0 items-center gap-2 border-t px-4 py-1.5 text-[11px] tabular-nums text-muted-foreground"
    >
      <span className="shrink-0 font-medium text-foreground">Free demo</span>
      <div
        className="h-1.5 min-w-16 flex-1 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-label="Free demo credit remaining"
        aria-valuemin={0}
        aria-valuemax={Math.round(budget.capUsd * 100)}
        aria-valuenow={Math.round(remaining * 100)}
      >
        <div
          className={cn("h-full rounded-full transition-[width]", low ? "bg-amber-500" : "bg-emerald-500")}
          style={{ width: `${(1 - usedFraction) * 100}%` }}
        />
      </div>
      <span className="shrink-0">
        {formatUsd(remaining)} left of {formatUsd(budget.capUsd)}
      </span>
    </div>
  );
}
