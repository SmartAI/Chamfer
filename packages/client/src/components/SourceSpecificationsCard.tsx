import { useState } from "react";
import { ChevronDown, ChevronRight, FileText, Image, MapPin, Quote } from "lucide-react";
import type { SourceSpecificationDto } from "@chamfer/shared";

export function SourceSpecificationsCard({
  specifications,
}: {
  specifications: readonly SourceSpecificationDto[];
}) {
  const [expanded, setExpanded] = useState(false);
  const activeCount = specifications.filter((specification) => specification.status === "active").length;
  const historicalCount = specifications.length - activeCount;

  return (
    <div
      data-testid="source-specifications-card"
      className="shrink-0 border-b border-sky-200 bg-sky-50/70 px-4 py-1.5 text-xs dark:border-sky-900 dark:bg-sky-950/20"
    >
      <button
        type="button"
        data-testid="source-specifications-toggle"
        aria-expanded={expanded}
        aria-controls="source-specifications-contents"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center gap-1.5 text-left text-sky-800 hover:text-sky-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:text-sky-200 dark:hover:text-sky-50"
      >
        {expanded
          ? <ChevronDown className="h-3 w-3 shrink-0" aria-hidden="true" />
          : <ChevronRight className="h-3 w-3 shrink-0" aria-hidden="true" />}
        <FileText className="h-3 w-3 shrink-0" aria-hidden="true" />
        <span className="font-medium">Source requirements</span>
        <span className="tabular-nums text-sky-700 dark:text-sky-300">
          {activeCount} active{historicalCount > 0 ? ` · ${historicalCount} history` : ""}
        </span>
        <span className="min-w-0 flex-1 truncate text-sky-700/80 dark:text-sky-300/80">
          Immutable requirements linked to exact source evidence
        </span>
      </button>
      {expanded && (
        <div
          id="source-specifications-contents"
          data-testid="source-specifications-contents"
          className="mt-1.5 flex max-h-[min(40vh,22rem)] flex-col gap-1 overflow-y-auto overscroll-contain pb-1 pl-4.5"
        >
          {specifications.map((specification) => (
            <div
              key={specification.id}
              data-testid="source-specification"
              className={`border-l-2 bg-background/70 px-2 py-1 ${specification.status === "active" ? "border-sky-400" : "border-muted-foreground/40 opacity-70"}`}
            >
              <div className="flex min-w-0 items-baseline gap-2">
                <span className="shrink-0 font-mono text-[10px] text-sky-700 dark:text-sky-300">
                  {specification.id}
                </span>
                <span className="min-w-0 text-foreground">{specification.requirement}</span>
                {specification.status === "superseded" && (
                  <span className="shrink-0 rounded bg-muted px-1 text-[9px] uppercase tracking-wide text-muted-foreground">
                    superseded
                  </span>
                )}
              </div>
              {"messageId" in specification.source ? (
                <div className="mt-0.5 flex min-w-0 items-start gap-1 text-[10px] text-muted-foreground">
                  <Quote className="mt-0.5 h-2.5 w-2.5 shrink-0" aria-hidden="true" />
                  <q className="min-w-0 break-words">{specification.source.text}</q>
                </div>
              ) : (
                <div className="mt-0.5 space-y-0.5 text-[10px] text-muted-foreground">
                  <div className="flex min-w-0 items-start gap-1">
                    <Image className="mt-0.5 h-2.5 w-2.5 shrink-0" aria-hidden="true" />
                    <span className="min-w-0 break-words">
                      Attachment <span className="font-mono">{specification.source.attachmentId}</span>: {specification.source.observation}
                    </span>
                  </div>
                  {specification.source.region && (
                    <div className="flex items-center gap-1 pl-3.5" data-testid="source-specification-region">
                      <MapPin className="h-2.5 w-2.5 shrink-0" aria-hidden="true" />
                      <span>
                        Region {Math.round(specification.source.region.x * 100)}%, {Math.round(specification.source.region.y * 100)}% · {Math.round(specification.source.region.width * 100)}% × {Math.round(specification.source.region.height * 100)}%
                      </span>
                    </div>
                  )}
                </div>
              )}
              {(specification.supersedesSpecificationIds?.length || specification.supersedesSpecificationId) && (
                <div className="mt-0.5 text-[10px] text-muted-foreground">
                  Replaces <span className="font-mono">
                    {(specification.supersedesSpecificationIds ?? [specification.supersedesSpecificationId]).filter(Boolean).join(", ")}
                  </span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
