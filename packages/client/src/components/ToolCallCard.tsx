import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { Measurements } from "@chamfer/shared";
import * as rest from "@/api/rest";
import { cn } from "@/lib/utils";
import { CadCodeActions } from "./CadCodeActions";

/** Shape of a run_build123d/lookup_docs tool-result as rendered by the card.
 * Exported so MessageList can reuse it instead of duplicating the type. */
export interface ToolCallCardResult {
  content?: unknown;
  details?: { measurements?: Measurements };
  isError?: boolean;
}

interface ToolCallCardProps {
  call: { id: string; name: string; arguments: Record<string, unknown> };
  result?: ToolCallCardResult;
  resultMessageId?: string;
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

export function ToolCallCard({ call, result, resultMessageId }: ToolCallCardProps) {
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
          {code && (
            <div className="overflow-hidden rounded-md border bg-muted/30">
              <div className="flex items-center justify-between border-b px-2 py-1.5">
                <span className="font-mono text-[11px] text-muted-foreground">Python</span>
                <CadCodeActions code={code} />
              </div>
              <pre className="max-h-56 overflow-auto whitespace-pre-wrap p-2 font-mono text-xs">{code}</pre>
            </div>
          )}
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
          {sheetUrl && <img src={sheetUrl} alt="Multi-view CAD inspection sheet" className="h-auto w-full border" />}
        </div>
      )}
    </div>
  );
}
