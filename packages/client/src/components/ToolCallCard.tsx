import { useEffect, useState } from "react";
import {
  BookOpen,
  ChevronDown,
  Code2,
  GraduationCap,
  ListChecks,
  type LucideIcon,
  NotebookPen,
  ScanEye,
  Search,
  ShieldCheck,
  Tags,
  Wrench,
} from "lucide-react";
import type { Gate, Measurements } from "@chamfer/shared";
import * as rest from "@/api/rest";
import { cn } from "@/lib/utils";
import { CadCodeBlock } from "./CadCodeBlock";
import { AttachmentImage } from "./AttachmentImage";
import type { AttachmentReferenceBlock } from "@chamfer/shared";

/** Humanize a raw snake_case tool name as a last-resort label. */
export function toolDisplayName(name: string): string {
  const spaced = name.replace(/_/g, " ").trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : name;
}

function trimmed(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** How a tool call reads in the chat: an icon plus a plain-language, one-line
 * summary built from its arguments/details. Keeps implementation names
 * (build123d, snake_case tool ids) out of the UI; the raw name still rides in
 * the row's `title` tooltip. */
interface ToolPresentation {
  Icon: LucideIcon;
  summary: string;
}

export function toolPresentation(
  call: { name: string; arguments: Record<string, unknown> },
  result?: ToolCallCardResult,
): ToolPresentation {
  const args = call.arguments ?? {};
  const details = (result?.details ?? {}) as Record<string, unknown>;
  const quote = (value: unknown): string => {
    const text = trimmed(value);
    return text ? ` “${text}”` : "";
  };

  switch (call.name) {
    case "run_build123d":
      return { Icon: Code2, summary: "Executing code" };
    case "search_docs":
      return { Icon: Search, summary: `Searched docs${quote(args.query)}` };
    case "lookup_docs":
      return { Icon: BookOpen, summary: `Looked up${quote(args.topic)}` };
    case "load_skill": {
      const name = trimmed(args.name) ?? trimmed(details.skill);
      const resource = trimmed(args.resource) ?? trimmed(details.resource);
      const named = name ? ` “${name}”` : "";
      if (resource) return { Icon: GraduationCap, summary: `Loaded “${resource}” from skill${named}` };
      if (details.deduped === true) return { Icon: GraduationCap, summary: name ? `Skill “${name}” already loaded` : "Skill already loaded" };
      return { Icon: GraduationCap, summary: `Loaded skill${named}` };
    }
    case "inspect_evidence": {
      const count = Array.isArray(args.evidenceIds) ? args.evidenceIds.length : 0;
      return { Icon: ScanEye, summary: count ? `Inspected ${count} reference${count === 1 ? "" : "s"}` : "Inspecting evidence" };
    }
    case "record_inspection_observation":
      return { Icon: NotebookPen, summary: "Recorded observation" };
    case "record_visual_verification":
    case "record_visual_verification_batch": {
      const verdict = trimmed(args.finalVerdict);
      const label = verdict === "needs-revision" ? "needs revision" : verdict === "match" ? "match" : undefined;
      return { Icon: ShieldCheck, summary: label ? `Visual check: ${label}` : "Recorded visual check" };
    }
    case "classify_reference":
      return { Icon: Tags, summary: "Classified reference" };
    case "update_plan":
      return { Icon: ListChecks, summary: "Updated plan" };
    default:
      return { Icon: Wrench, summary: toolDisplayName(call.name) };
  }
}

/** Shape of a tool-result as rendered by the card. `details` is a per-tool bag:
 * run_build123d carries measurements/gate, load_skill carries skill/resource.
 * Exported so MessageList can reuse it instead of duplicating the type. */
export interface ToolCallCardResult {
  content?: unknown;
  details?: {
    measurements?: Measurements;
    gate?: Gate;
    skill?: string;
    resource?: string;
    deduped?: boolean;
    loaded?: boolean;
  };
  isError?: boolean;
}

interface ToolCallCardProps {
  call: { id: string; name: string; arguments: Record<string, unknown> };
  result?: ToolCallCardResult;
  /** The assistant response ended in failure before this tool produced a result. */
  interrupted?: boolean;
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

function attachmentReference(content: unknown): AttachmentReferenceBlock | undefined {
  if (!Array.isArray(content)) return undefined;
  return content.find(
    (block): block is AttachmentReferenceBlock =>
      typeof block === "object" &&
      block !== null &&
      (block as { type?: unknown }).type === "attachment-reference" &&
      (block as { kind?: unknown }).kind === "view-sheet" &&
      typeof (block as { attachmentId?: unknown }).attachmentId === "string" &&
      typeof (block as { mimeType?: unknown }).mimeType === "string",
  );
}

type InspectionEvidenceBlock =
  | { type: "inline"; url: string }
  | { type: "reference"; reference: AttachmentReferenceBlock };

function inspectionEvidenceBlocks(content: unknown): InspectionEvidenceBlock[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((block): InspectionEvidenceBlock[] => {
    if (typeof block !== "object" || block === null) return [];
    const candidate = block as Record<string, unknown>;
    if (candidate.type === "image" && typeof candidate.data === "string" && typeof candidate.mimeType === "string") {
      return [{ type: "inline", url: `data:${candidate.mimeType};base64,${candidate.data}` }];
    }
    if (
      candidate.type === "attachment-reference" &&
      typeof candidate.attachmentId === "string" &&
      typeof candidate.mimeType === "string" &&
      (candidate.kind === "user-image" || candidate.kind === "view-sheet")
    ) {
      return [{ type: "reference", reference: candidate as unknown as AttachmentReferenceBlock }];
    }
    return [];
  });
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

/** Joined text content of a tool result, or "" when it carries none. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("\n")
    .trim();
}

/** Tools whose text result is worth reading inline (doc lookups). Other
 * text-only tools are fully summarized by the header, so they get no body. */
const READABLE_TEXT_TOOLS = new Set(["search_docs", "lookup_docs"]);

export function ToolCallCard({ call, result, interrupted = false, resultMessageId, showCadCode = false }: ToolCallCardProps) {
  const heavy = call.name === "run_build123d" || call.name === "inspect_evidence";
  const [expanded, setExpanded] = useState(heavy);
  const [sheetUrl, setSheetUrl] = useState<string | undefined>(() => inlineImage(result?.content));
  const sheetReference = attachmentReference(result?.content);
  const inspectedEvidence = call.name === "inspect_evidence" ? inspectionEvidenceBlocks(result?.content) : [];

  useEffect(() => {
    const fallback = inlineImage(result?.content);
    setSheetUrl(fallback);
    if (sheetReference || !resultMessageId) return;
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
  }, [result?.content, resultMessageId, sheetReference]);

  const { Icon, summary } = toolPresentation(call, result);
  const code = typeof call.arguments.code === "string" ? call.arguments.code : "";
  const measurements = result?.details?.measurements;
  const gate = result?.details?.gate;
  const gateFailures = gate?.checks.filter((check) => !check.passed) ?? [];
  const docText = !result?.isError && READABLE_TEXT_TOOLS.has(call.name) ? resultText(result?.content) : "";
  const hasImages = inspectedEvidence.length > 0 || Boolean(sheetReference) || Boolean(sheetUrl);
  const hasBody = Boolean(result?.isError || code || measurements || gate || docText || hasImages);

  const header = (
    <>
      <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span title={call.name} className="min-w-0 flex-1 truncate whitespace-nowrap">{summary}</span>
      <span className={cn("shrink-0", result?.isError || interrupted ? "text-destructive" : "text-muted-foreground")}>
        {result ? (result.isError ? "Failed" : "Complete") : interrupted ? "Failed" : "Running"}
      </span>
      {hasBody && (
        <ChevronDown className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform", !expanded && "-rotate-90")} />
      )}
    </>
  );

  return (
    <div data-testid="tool-call-card" className="mt-2 overflow-hidden rounded-md border bg-background text-foreground">
      {hasBody ? (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium hover:bg-accent"
        >
          {header}
        </button>
      ) : (
        <div className="flex w-full items-center gap-2 px-3 py-2 text-xs font-medium">{header}</div>
      )}
      {hasBody && expanded && (
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
          {docText && (
            <pre
              data-testid="tool-doc-text"
              className="max-h-60 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-2 font-mono text-xs text-foreground"
            >
              {docText}
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
          {inspectedEvidence.length > 0 ? (
            <div data-testid="inspection-evidence-list" className="grid grid-cols-1 gap-2">
              {inspectedEvidence.map((evidence, index) =>
                evidence.type === "reference" ? (
                  <AttachmentImage
                    key={`${evidence.reference.attachmentId}-${index}`}
                    reference={evidence.reference}
                    testId="inspection-evidence-image"
                    alt={`Inspected evidence ${index + 1}`}
                    className="h-auto max-h-80 w-full object-contain border"
                  />
                ) : (
                  <img
                    key={`inline-${index}`}
                    data-testid="inspection-evidence-image"
                    src={evidence.url}
                    alt={`Inspected evidence ${index + 1}`}
                    className="h-auto max-h-80 w-full object-contain border"
                  />
                ),
              )}
            </div>
          ) : sheetReference ? (
            <AttachmentImage
              reference={sheetReference}
              testId="view-sheet-image"
              alt="Multi-view CAD inspection sheet"
              className="h-auto w-full border"
            />
          ) : sheetUrl ? (
            <img data-testid="view-sheet-image" src={sheetUrl} alt="Multi-view CAD inspection sheet" className="h-auto w-full border" />
          ) : null}
        </div>
      )}
    </div>
  );
}
