import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { Gate, Measurements } from "@chamfer/shared";
import * as rest from "@/api/rest";
import { cn } from "@/lib/utils";
import { CadCodeBlock } from "./CadCodeBlock";

/** Shape of a run_build123d/lookup_docs tool-result as rendered by the card.
 * Exported so MessageList can reuse it instead of duplicating the type. */
export interface ToolCallCardResult {
  content?: unknown;
  details?: { measurements?: Measurements; gate?: Gate };
  isError?: boolean;
}

interface ToolCallCardProps {
  call: { id: string; name: string; arguments: Record<string, unknown> };
  result?: ToolCallCardResult;
  resultMessageId?: string;
  /** Whether the CAD code body is rendered. Off by default (CHAMFER_SHOW_CAD_CODE
   * gates it); hidden mode keeps the label-and-actions row so Copy/Render 3D
   * still work. */
  showCadCode?: boolean;
}

function inlineImage(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const image = content.find(
    (block): block is { type: "image"; data: string; mimeType: string } =>
      typeof block === "object" &&
      block !== null &&
      (block as { type?: unknown }).type === "image" &&
      typeof (block as { data?: unknown }).data === "string" &&
      typeof (block as { mimeType?: unknown }).mimeType === "string",
  );
  return image ? `data:${image.mimeType};base64,${image.data}` : undefined;
}

function errorText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "Tool call failed";
  const text = content
    .filter(
      (block): block is { type: "text"; text: string } =>
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("\n");
  return text || "Tool call failed";
}

export function ToolCallCard({ call, result, resultMessageId, showCadCode = false }: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(true);
  const [sheetUrl, setSheetUrl] = useState<string | undefined>(() => inlineImage(result?.content));

  useEffect(() => {
    const fallback = inlineImage(result?.content);
    setSheetUrl(fallback);
    if (!resultMessageId) return;
    let cancelled = false;
    void rest
      .listAttachments(resultMessageId)
      .then((attachments) => {
        if (cancelled) return;
        const sheet = attachments.find((attachment) => attachment.kind === "view-sheet");
        if (sheet) setSheetUrl(rest.attachmentUrl(sheet.id));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [result?.content, resultMessageId]);

  const code = typeof call.arguments.code === "string" ? call.arguments.code : "";
  const measurements = result?.details?.measurements;
  const gate = result?.details?.gate;
  const gateFailures = gate?.checks.filter((check) => !check.passed) ?? [];

  return (
    <div data-testid="tool-call-card" className="mt-2 overflow-hidden rounded-md border bg-background text-foreground">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium hover:bg-accent"
      >
        <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", !expanded && "-rotate-90")} />
        <span className="font-mono">{call.name}</span>
        <span className={cn("ml-auto", result?.isError ? "text-destructive" : "text-muted-foreground")}>
          {result ? (result.isError ? "Failed" : "Complete") : "Running"}
        </span>
      </button>
      {expanded && (
        <div className="space-y-3 border-t p-3">
          {code && <CadCodeBlock code={code} show={showCadCode} className="bg-muted/30" />}
          {result?.isError && (
            <pre
              data-testid="tool-error"
              className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-destructive bg-destructive/10 p-2 font-mono text-xs text-destructive"
            >
              {errorText(result.content)}
            </pre>
          )}
          {measurements && (
            <div data-testid="tool-measurements" className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
              <span className="text-muted-foreground">Bounds</span>
              <span>{measurements.bboxMm.join(" x ")} mm</span>
              <span className="text-muted-foreground">Volume</span>
              <span>{measurements.volumeMm3} mm3</span>
              <span className="text-muted-foreground">Area</span>
              <span>{measurements.areaMm2} mm2</span>
            </div>
          )}
          {gate && (
            <div
              data-testid="tool-gate"
              data-status={gate.status}
              className="overflow-hidden rounded-md border text-xs"
            >
              <div className="flex items-center gap-2 border-b bg-muted/40 px-2 py-1.5 font-medium">
                <span
                  aria-hidden="true"
                  className={cn(
                    "h-1.5 w-1.5 rounded-full",
                    gate.status === "passed" && "bg-emerald-500",
                    gate.status === "failed" && "bg-red-500",
                    gate.status === "error" && "bg-muted-foreground",
                  )}
                />
                Verification
                <span className="ml-auto font-normal text-muted-foreground">{gate.checks.length} checks</span>
              </div>
              {gate.status === "error" ? (
                <div className="p-2 text-muted-foreground">
                  Verification unavailable — the evaluator errored; inspect the views manually.
                  <div className="mt-1 font-mono">{gate.checks.map((check) => check.detail).join("; ")}</div>
                </div>
              ) : (
                <>
                  <ul>
                    {gate.checks.map((check, index) => (
                      <li
                        key={check.name}
                        className={cn(
                          "flex items-baseline gap-2 border-b border-dashed px-2 py-1 font-mono last:border-b-0",
                          !check.passed && "bg-destructive/10",
                        )}
                      >
                        <span
                          className={cn(
                            check.passed ? "gate-tick text-emerald-600" : "text-destructive",
                            "font-semibold",
                          )}
                          style={check.passed ? { animationDelay: `${index * 120}ms` } : undefined}
                        >
                          {check.passed ? "✓" : "✕"}
                        </span>
                        <span className={cn("min-w-20 font-semibold", !check.passed && "text-destructive")}>
                          {check.name}
                        </span>
                        <span className={cn("text-muted-foreground", !check.passed && "text-destructive")}>
                          {check.detail}
                        </span>
                      </li>
                    ))}
                  </ul>
                  <div
                    className={cn(
                      "px-2 py-1.5 font-semibold tracking-wide",
                      gate.status === "passed"
                        ? "bg-emerald-50 text-emerald-700"
                        : "bg-destructive/10 text-destructive",
                    )}
                  >
                    {gate.status === "passed"
                      ? "GATE PASSED — all declared expectations met"
                      : `GATE FAILED — ${gateFailures.length} of ${gate.checks.length} checks failed`}
                  </div>
                </>
              )}
            </div>
          )}
          {sheetUrl && <img src={sheetUrl} alt="Multi-view CAD inspection sheet" className="h-auto w-full border" />}
        </div>
      )}
    </div>
  );
}
