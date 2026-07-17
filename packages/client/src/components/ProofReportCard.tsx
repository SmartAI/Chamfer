import { useState } from "react";
import { ChevronDown, ChevronRight, Download, FileCheck2 } from "lucide-react";
import type { ProofEvidenceState, ProofReportDto } from "@chamfer/shared";
import { cn } from "@/lib/utils";

const LABELS: Record<ProofEvidenceState, string> = {
  proven: "Proven",
  failed: "Failed",
  unavailable: "Unavailable",
  "not-applicable": "Not applicable",
  stale: "Stale",
};

function badgeClass(state: ProofEvidenceState): string {
  if (state === "proven") return "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200";
  if (state === "failed") return "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200";
  if (state === "unavailable") return "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200";
  return "bg-slate-100 text-slate-700 dark:bg-slate-900 dark:text-slate-200";
}

function StateBadge({ state }: { state: ProofEvidenceState }) {
  return (
    <span className={cn("shrink-0 whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide", badgeClass(state))}>
      {LABELS[state]}
    </span>
  );
}

function downloadReport(report: ProofReportDto): void {
  const url = URL.createObjectURL(new Blob([`${JSON.stringify(report, null, 2)}\n`], { type: "application/json" }));
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `chamfer-proof-report-${report.cadArtifact.version}.json`;
    anchor.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function ProofReportCard({ report }: { report: ProofReportDto }) {
  const [expanded, setExpanded] = useState(false);
  const reportState = report.status;
  const surfaceClass = reportState === "proven"
    ? "border-emerald-200 bg-emerald-50/60 dark:border-emerald-900 dark:bg-emerald-950/20"
    : reportState === "failed"
      ? "border-red-200 bg-red-50/60 dark:border-red-900 dark:bg-red-950/20"
      : reportState === "unavailable"
        ? "border-amber-200 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/20"
        : "border-slate-200 bg-slate-50/70 dark:border-slate-800 dark:bg-slate-950/30";

  return (
    <section
      data-testid="proof-report-card"
      data-proof-report-status={reportState}
      className={cn("shrink-0 border-b px-4 py-1.5 text-xs", surfaceClass)}
    >
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls="proof-report-contents"
          onClick={() => setExpanded((value) => !value)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {expanded
            ? <ChevronDown className="h-3 w-3 shrink-0" aria-hidden="true" />
            : <ChevronRight className="h-3 w-3 shrink-0" aria-hidden="true" />}
          <FileCheck2 className="h-3 w-3 shrink-0" aria-hidden="true" />
          <span className="shrink-0 whitespace-nowrap font-medium">Proof report</span>
          <StateBadge state={reportState} />
          <span className="min-w-0 truncate tabular-nums text-muted-foreground">CAD artifact {report.cadArtifact.version}</span>
        </button>
        <button
          type="button"
          data-testid="proof-report-download"
          aria-label="Download proof report JSON"
          title="Download proof report JSON"
          onClick={() => downloadReport(report)}
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Download className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
      <div className="mt-0.5 flex gap-3 pl-6 text-[10px] text-muted-foreground">
        <span>Shape proof {LABELS[report.shapeProof.state]}</span>
        <span>Visual verification {LABELS[report.visualVerification.state]}</span>
      </div>
      {expanded && (
        <div
          id="proof-report-contents"
          data-testid="proof-report-contents"
          className="mt-2 grid max-h-[min(48vh,30rem)] grid-cols-2 gap-x-4 gap-y-2 overflow-y-auto overscroll-contain pb-1 pl-6"
        >
          <section>
            <h3 className="font-medium">Engineering verification</h3>
            <div className="mt-0.5 flex items-center gap-1.5"><StateBadge state={report.engineering.state} /></div>
            <ul className="mt-1 space-y-0.5 text-muted-foreground">
              <li>Verification gate: {LABELS[report.engineering.verificationGate.state]}</li>
              <li>Plan conformance: {LABELS[report.engineering.planConformance.state]}</li>
              <li>{report.engineering.verificationGate.checks.length} kernel verdicts</li>
            </ul>
          </section>
          <section>
            <h3 className="font-medium">Body integrity</h3>
            <div className="mt-0.5 flex items-center gap-1.5"><StateBadge state={report.bodyIntegrity.state} /></div>
            <p className="mt-1 text-muted-foreground">
              {report.bodyIntegrity.verdict
                ? `${report.bodyIntegrity.verdict.solidCount} connected solid${report.bodyIntegrity.verdict.solidCount === 1 ? "" : "s"}; ${report.bodyIntegrity.verdict.valid ? "valid topology" : "invalid topology"}`
                : "No integrity verdict is available."}
            </p>
          </section>
          <section>
            <h3 className="font-medium">Version binding</h3>
            <ul className="mt-1 space-y-0.5 font-mono text-[10px] text-muted-foreground">
              <li>Contract {report.proofContract.contractId} r{report.proofContract.revision}</li>
              <li>Plan {report.acceptedPlan.planId} r{report.acceptedPlan.revision}</li>
              <li>Criteria r{report.acceptedPlan.criteriaRevision}</li>
              <li>Artifact {report.cadArtifact.id} v{report.cadArtifact.version}</li>
            </ul>
          </section>
          <section>
            <h3 className="font-medium">Evidence coverage</h3>
            <ul className="mt-1 space-y-0.5 text-muted-foreground">
              <li>{report.sourceSpecifications.length} active design specifications</li>
              <li>{(report.referenceRegistrations ?? []).length} registered reference views</li>
              <li>{report.assumptions.length} disclosed assumptions</li>
              <li>{report.unavailableEvidence.length} unavailable evidence items</li>
              <li>Shape proof: {LABELS[report.shapeProof.state]}</li>
              <li>Visual verification: {LABELS[report.visualVerification.state]}</li>
            </ul>
          </section>
          {report.shapeProof.state !== "not-applicable" && (
            <section className="col-span-2" data-testid="proof-report-shape-details">
              <h3 className="font-medium">Independent shape proof</h3>
              <p className="mt-0.5 text-muted-foreground">{report.shapeProof.reason}</p>
              {report.shapeProof.record && (
                <ul className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 text-muted-foreground">
                  {report.shapeProof.record.views.map((view) => (
                    <li key={`${view.registration.id}@${view.registration.revision}`}>
                      {view.registration.direction} r{view.registration.revision}: {view.status}
                      {view.metrics
                        ? `, IoU ${view.metrics.silhouetteIou.toFixed(3)}, contour ${view.metrics.symmetricContourDistanceMm.toFixed(3)} mm`
                        : ""}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
          {report.visualVerification.state !== "not-applicable" && (
            <section className="col-span-2" data-testid="proof-report-visual-details">
              <h3 className="font-medium">Semantic visual verification</h3>
              <p className="mt-0.5 text-muted-foreground">{report.visualVerification.reason}</p>
              {report.visualVerification.record && (
                <ul className="mt-1 font-mono text-[10px] text-muted-foreground">
                  <li>Record {report.visualVerification.record.id}</li>
                  <li>Sheet {report.visualVerification.record.inspectionSheetId}</li>
                  <li>{report.visualVerification.record.coveredReferenceIds.length} covered references</li>
                </ul>
              )}
            </section>
          )}
          {(report.referenceRegistrations ?? []).length > 0 && (
            <section className="col-span-2" data-testid="proof-report-registration-details">
              <h3 className="font-medium">Registered reference provenance</h3>
              <ul className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 font-mono text-[10px] text-muted-foreground">
                {(report.referenceRegistrations ?? []).map((registration) => (
                  <li key={`${registration.registrationId}@${registration.revision}`}>
                    {registration.direction ?? "unknown"}: {registration.registrationId} r{registration.revision} - {registration.referenceId}
                  </li>
                ))}
              </ul>
            </section>
          )}
          <p className="col-span-2 text-[10px] text-muted-foreground">
            Created {new Date(report.createdAt).toLocaleString()}
          </p>
        </div>
      )}
    </section>
  );
}
