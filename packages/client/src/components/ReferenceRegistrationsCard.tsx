import { useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, ScanLine } from "lucide-react";
import type { ReferenceRegistrationDto } from "@chamfer/shared";
import { currentReferenceRegistrations } from "../agent/referenceRegistrations";

function titleOf(registration: ReferenceRegistrationDto): string {
  if (registration.projection !== "orthographic") {
    return `${registration.projection[0]!.toUpperCase()}${registration.projection.slice(1)} reference`;
  }
  const direction = registration.direction
    ? `${registration.direction[0]!.toUpperCase()}${registration.direction.slice(1)} `
    : "";
  return `${direction}orthographic`;
}

function contourPath(registration: ReferenceRegistrationDto): string | undefined {
  const points = registration.geometry.contour?.points;
  if (!points?.length) return undefined;
  return `${points.map(([x, y], index) => `${index === 0 ? "M" : "L"} ${x} ${y}`).join(" ")} Z`;
}

export function ReferenceRegistrationsCard({ registrations }: { registrations: ReferenceRegistrationDto[] }) {
  const [expanded, setExpanded] = useState(false);
  const current = currentReferenceRegistrations(registrations);
  if (current.length === 0) return null;
  const eligibleCount = current.filter((registration) => registration.eligibility.status === "eligible").length;
  const aggregateEligibility = eligibleCount === current.length ? "eligible" : eligibleCount === 0 ? "advisory" : "mixed";
  const first = current[0]!;
  const firstScale = first.geometry.scaleTransform;

  return (
    <div
      data-testid="reference-registration-card"
      data-eligibility={aggregateEligibility}
      className="shrink-0 border-b border-cyan-200 bg-cyan-50/70 px-4 py-1.5 text-xs dark:border-cyan-900 dark:bg-cyan-950/20"
    >
      <button
        type="button"
        data-testid="reference-registration-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center gap-1.5 text-left text-cyan-900 hover:text-cyan-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:text-cyan-100"
      >
        {expanded
          ? <ChevronDown className="h-3 w-3 shrink-0" aria-hidden="true" />
          : <ChevronRight className="h-3 w-3 shrink-0" aria-hidden="true" />}
        <ScanLine className="h-3 w-3 shrink-0" aria-hidden="true" />
        <span className="font-medium">Reference registration</span>
        <span className={`rounded px-1 text-[10px] font-medium uppercase tracking-wide ${
          aggregateEligibility === "eligible"
            ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
            : "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300"
        }`}>
          {aggregateEligibility}
        </span>
        <span className="min-w-0 flex-1 truncate text-cyan-800/80 dark:text-cyan-200/80">
          {titleOf(first)} · {firstScale ? `${firstScale.physicalLengthMm} mm anchor` : "Unscaled"} · Revision {first.revision}
        </span>
      </button>
      {expanded && (
        <div className="mt-2 grid max-h-[min(48vh,30rem)] gap-2 overflow-y-auto overscroll-contain pb-1 pl-4.5">
          {current.map((registration) => {
            const path = contourPath(registration);
            const scale = registration.geometry.scaleTransform;
            return (
              <section
                key={`${registration.registrationId}:${registration.revision}`}
                data-testid="reference-registration"
                data-registration-status={registration.eligibility.status}
                className="grid min-w-0 grid-cols-[5.5rem_1fr] gap-2 rounded-md border border-cyan-200/80 bg-background/75 p-2 dark:border-cyan-900"
              >
                <div className="flex h-20 items-center justify-center overflow-hidden rounded border bg-white p-1 dark:bg-slate-950">
                  {path ? (
                    <svg
                      data-testid="reference-contour-preview"
                      viewBox={`0 0 ${registration.geometry.regionPx.width} ${registration.geometry.regionPx.height}`}
                      className="h-full w-full"
                      preserveAspectRatio="xMidYMid meet"
                      aria-label="Deterministically extracted source contour"
                    >
                      <path d={path} fill="rgb(207 250 254)" stroke="rgb(8 145 178)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
                    </svg>
                  ) : (
                    <AlertTriangle className="h-5 w-5 text-amber-600" aria-label="Contour unavailable" />
                  )}
                </div>
                <div className="min-w-0 space-y-1">
                  <div className="flex items-center gap-1">
                    <span className="font-medium text-foreground">{titleOf(registration)}</span>
                    <span className="font-mono text-[10px] text-muted-foreground">r{registration.revision}</span>
                  </div>
                  <p className="font-mono text-[10px] text-muted-foreground break-all">{registration.referenceId}</p>
                  <p className="text-muted-foreground">
                    {scale
                      ? `${scale.physicalLengthMm} mm / ${scale.pixelLength.toFixed(1)} px = ${scale.mmPerPixel.toFixed(4)} mm/px`
                      : "No physical scale transform"}
                  </p>
                  <p className="text-muted-foreground">
                    {registration.geometry.contour
                      ? `${registration.geometry.contour.points.length} contour points · ${registration.visibleLandmarks.length} landmarks`
                      : registration.geometry.extraction.reason}
                  </p>
                  <p className="text-muted-foreground">Uncertainty: {registration.uncertainty.level}. {registration.uncertainty.notes}</p>
                  {registration.eligibility.reasons.length > 0 && (
                    <ul data-testid="reference-registration-reasons" className="space-y-0.5 text-amber-800 dark:text-amber-300">
                      {registration.eligibility.reasons.map((reason) => <li key={reason}>- {reason}</li>)}
                    </ul>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
