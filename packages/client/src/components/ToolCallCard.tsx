import { useState } from "react";
import { ChevronDown, Wrench } from "lucide-react";
import { cn } from "@/lib/utils";

/** Humanize a raw snake_case tool name as a display label. */
export function toolDisplayName(name: string): string {
  const spaced = name.replace(/_/g, " ").trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : name;
}

export interface ToolCallCardCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** Tool-result message shape (pi ToolResultMessage): content blocks + error flag. */
export interface ToolCallCardResult {
  content?: unknown;
  isError?: boolean;
}

interface TextBlock {
  type: "text";
  text: string;
}

interface ImageBlock {
  type: "image";
  data: string;
  mimeType: string;
}

function isTextBlock(value: unknown): value is TextBlock {
  return typeof value === "object" && value !== null &&
    (value as { type?: unknown }).type === "text" &&
    typeof (value as { text?: unknown }).text === "string";
}

function isImageBlock(value: unknown): value is ImageBlock {
  return typeof value === "object" && value !== null &&
    (value as { type?: unknown }).type === "image" &&
    typeof (value as { data?: unknown }).data === "string" &&
    typeof (value as { mimeType?: unknown }).mimeType === "string";
}

function resultText(result: ToolCallCardResult | undefined): string {
  if (!Array.isArray(result?.content)) return "";
  return result.content.filter(isTextBlock).map((block) => block.text).join("\n");
}

function resultImages(result: ToolCallCardResult | undefined): ImageBlock[] {
  if (!Array.isArray(result?.content)) return [];
  return result.content.filter(isImageBlock);
}

export interface ToolCallCardProps {
  call: ToolCallCardCall;
  result?: ToolCallCardResult;
  /** True when the turn failed before this call's result arrived. */
  interrupted?: boolean;
  /** Kept for API compatibility with the chat renderer; args/results show regardless. */
  showCadCode?: boolean;
}

/** Generic MCP tool-call card: tool name header with status, and a collapsed
 * body carrying the raw arguments and the verbatim result (text and images). */
export function ToolCallCard({ call, result, interrupted = false }: ToolCallCardProps) {
  const [open, setOpen] = useState(false);
  const failed = result?.isError === true;
  const pending = !result && !interrupted;
  const text = resultText(result);
  const images = resultImages(result);

  return (
    <div
      data-testid="tool-call-card"
      data-tool-name={call.name}
      className={cn(
        "my-2 overflow-hidden rounded-md border bg-background text-xs",
        failed && "border-red-300 dark:border-red-800",
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-accent/50"
      >
        <Wrench className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate font-medium">{toolDisplayName(call.name)}</span>
        <span
          data-testid="tool-call-status"
          className={cn(
            "shrink-0 rounded-full px-2 py-0.5 text-[10px]",
            pending && "bg-muted text-muted-foreground",
            !pending && failed && "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
            !pending && !failed && result && "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
            interrupted && !result && "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
          )}
        >
          {result ? (failed ? "failed" : "done") : interrupted ? "interrupted" : "running"}
        </span>
        <ChevronDown
          className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")}
          aria-hidden="true"
        />
      </button>
      {open && (
        <div className="border-t px-2.5 py-2">
          <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Arguments</p>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-2">
            {JSON.stringify(call.arguments, null, 2)}
          </pre>
          {(text || images.length > 0) && (
            <>
              <p className="mb-1 mt-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Result
              </p>
              {text && (
                <pre
                  data-testid="tool-result-text"
                  className={cn(
                    "max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-2",
                    failed && "text-red-700 dark:text-red-300",
                  )}
                >
                  {text}
                </pre>
              )}
              {images.map((image, index) => (
                <img
                  key={index}
                  data-testid="tool-result-image"
                  src={`data:${image.mimeType};base64,${image.data}`}
                  alt={`${call.name} result`}
                  className="mt-2 max-h-64 max-w-full rounded border object-contain"
                />
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
