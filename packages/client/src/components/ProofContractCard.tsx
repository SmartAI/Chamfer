import { useState } from "react";
import { CheckSquare, ChevronDown, ChevronRight, EyeOff, ShieldCheck } from "lucide-react";
import type { ProofContractCriterionCategory, ProofContractDto } from "@chamfer/shared";

const GROUPS: Array<{ category: ProofContractCriterionCategory; label: string }> = [
  { category: "explicit-requirement", label: "Explicit requirements" },
  { category: "source-derived-requirement", label: "Source-derived requirements" },
  { category: "conservative-default", label: "Conservative defaults" },
  { category: "agent-assumption", label: "Agent assumptions" },
];

export function ProofContractCard({ contract }: { contract: ProofContractDto }) {
  const [expanded, setExpanded] = useState(false);
  const assumptionCount = contract.derivation.criteria.filter((criterion) =>
    criterion.category === "agent-assumption",
  ).length;

  return (
    <div
      data-testid="proof-contract-card"
      data-contract-status={contract.status}
      data-proof-status={contract.proofStatus}
      data-shape-proof-status={contract.derivation.shapeProof.status}
      className="shrink-0 border-b border-violet-200 bg-violet-50/60 px-4 py-1.5 text-xs dark:border-violet-900 dark:bg-violet-950/20"
    >
      <button
        type="button"
        data-testid="proof-contract-toggle"
        aria-expanded={expanded}
        aria-controls="proof-contract-contents"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center gap-1.5 text-left text-violet-800 hover:text-violet-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:text-violet-200 dark:hover:text-violet-50"
      >
        {expanded
          ? <ChevronDown className="h-3 w-3 shrink-0" aria-hidden="true" />
          : <ChevronRight className="h-3 w-3 shrink-0" aria-hidden="true" />}
        <ShieldCheck className="h-3 w-3 shrink-0" aria-hidden="true" />
        <span className="font-medium">Proof contract</span>
        <span data-testid="proof-contract-revision" className="tabular-nums">
          Revision {contract.revision}
        </span>
        <span className="rounded bg-violet-100 px-1 text-[10px] uppercase tracking-wide text-violet-700 dark:bg-violet-900 dark:text-violet-200">
          {contract.proofStatus}
        </span>
        <span className="min-w-0 flex-1 truncate text-violet-700/80 dark:text-violet-300/80">
          Frozen autonomously · {assumptionCount} assumptions
        </span>
      </button>
      {expanded && (
        <div
          id="proof-contract-contents"
          data-testid="proof-contract-contents"
          className="mt-1.5 flex max-h-[min(46vh,28rem)] flex-col gap-2 overflow-y-auto overscroll-contain pb-1 pl-4.5"
        >
          <div className="font-mono text-[10px] text-violet-700 dark:text-violet-300">
            {contract.contractId} · plan {contract.derivation.planId} · criteria {contract.derivation.criteriaRevision}
          </div>
          {GROUPS.map((group) => {
            const criteria = contract.derivation.criteria.filter((criterion) => criterion.category === group.category);
            return (
              <section key={group.category} data-testid={`proof-contract-${group.category}`}>
                <h3 className="font-medium text-foreground">{group.label} ({criteria.length})</h3>
                {criteria.length === 0 ? (
                  <p className="text-muted-foreground">None</p>
                ) : (
                  <ul className="mt-0.5 space-y-0.5 text-muted-foreground">
                    {criteria.map((criterion) => <li key={criterion.id}>- {criterion.statement}</li>)}
                  </ul>
                )}
              </section>
            );
          })}
          <section data-testid="proof-contract-planned-checks">
            <h3 className="flex items-center gap-1 font-medium text-foreground">
              <CheckSquare className="h-3 w-3" aria-hidden="true" />
              Planned checks ({contract.derivation.plannedChecks.length})
            </h3>
            <ul className="mt-0.5 space-y-0.5 text-muted-foreground">
              {contract.derivation.plannedChecks.map((check) => (
                <li key={`${check.componentId}:${check.id}`} className="font-mono">
                  - {check.componentId}.{check.id}: {check.kind}
                </li>
              ))}
            </ul>
          </section>
          <section data-testid="proof-contract-unavailable-evidence">
            <h3 className="font-medium text-foreground">
              Unavailable evidence ({contract.derivation.unavailableEvidence.length})
            </h3>
            {contract.derivation.unavailableEvidence.length === 0 ? (
              <p className="text-muted-foreground">None</p>
            ) : (
              <ul className="mt-0.5 space-y-0.5 text-muted-foreground">
                {contract.derivation.unavailableEvidence.map((item) => (
                  <li key={item.id}>- {item.requirement}: {item.reason}</li>
                ))}
              </ul>
            )}
          </section>
          <section
            data-testid="proof-contract-shape-proof"
            className="flex items-start gap-1 border-l-2 border-slate-300 pl-2 text-muted-foreground"
          >
            <EyeOff className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
            <span>
              <span className="font-medium text-foreground">
                Shape proof: {contract.derivation.shapeProof.status.replace("-", " ")}.
              </span>{" "}
              {contract.derivation.shapeProof.reason}
              {contract.derivation.shapeProof.status !== "not-applicable" && (
                <span className="mt-0.5 block font-mono text-[10px]">
                  {contract.derivation.shapeProof.registrations.map((registration) =>
                    `${registration.referenceId} @ registration r${registration.revision} (${registration.eligibility})`,
                  ).join(" · ")}
                </span>
              )}
            </span>
          </section>
        </div>
      )}
    </div>
  );
}
