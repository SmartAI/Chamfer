import {
  Children,
  createContext,
  isValidElement,
  useContext,
  useEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import { Streamdown, type Components, type CustomRendererProps } from "streamdown";
import { createMathPlugin } from "@streamdown/math";
import "katex/dist/katex.min.css";
import { ArrowDown, Check, CheckCircle2, CircleAlert, FoldVertical, LoaderCircle, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ActiveTool } from "@/state/agentEventFold";
import { ToolCallCard, toolDisplayName, type ToolCallCardResult } from "./ToolCallCard";
import { CadCodeBlock } from "./CadCodeBlock";
import { AttachmentImage } from "./AttachmentImage";
import type { AttachmentReferenceBlock } from "@chamfer/shared";

/** Whether CAD code bodies render in chat (CHAMFER_SHOW_CAD_CODE). A module-local
 * context, not a prop, because the fence renderer sits behind Streamdown's static
 * renderer registry and cannot receive props from MessageList. */
const CadCodeVisibilityContext = createContext(false);

function CadCodeFence({ code, isIncomplete }: CustomRendererProps) {
  const showCadCode = useContext(CadCodeVisibilityContext);
  return <CadCodeBlock code={code} show={showCadCode} disabled={isIncomplete} className="my-2 bg-background" />;
}

const CAD_CODE_RENDERERS = [{ language: ["python", "py"], component: CadCodeFence }];

// Models write verification math as single-dollar inline LaTeX ("$3897.67
// \text{ mm}^3$"), which the plugin's default (double-dollar only) would leave
// as raw source.
const MATH_PLUGIN = createMathPlugin({ singleDollarTextMath: true });

// The self-check nudge asks the model to "mark each one satisfied or missing",
// which it phrases either as a prefix ("Satisfied: four holes are present") or
// a suffix ("Width: 10 mm: Satisfied"). Both render as an icon row instead of
// the bare word. Prefix/suffix must sit against a colon so prose like "all
// requirements are satisfied." passes through untouched.
const PASS_PREFIX = /^\s*satisfied[:.]\s*/i;
const FAIL_PREFIX = /^\s*(?:not\s+satisfied|unsatisfied|missing|not\s+met)[:.]\s*/i;
const PASS_SUFFIX = /[:—-]\s*satisfied\s*[.!]?\s*$/i;
const FAIL_SUFFIX = /[:—-]\s*(?:not\s+satisfied|unsatisfied|missing|not\s+met)\s*[.!]?\s*$/i;
// A whole child element (inline code, bold, …) carrying nothing but the verdict,
// e.g. the `Satisfied` / **Not satisfied:** stylings some models produce.
const PASS_ONLY = /^\s*satisfied\s*[:.]?\s*$/i;
const FAIL_ONLY = /^\s*(?:not\s+satisfied|unsatisfied|missing|not\s+met)\s*[:.]?\s*$/i;

/** Concatenated string content of a node, or null if it contains non-text children. */
function nodeText(node: ReactNode): string | null {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (isValidElement(node)) {
    let text = "";
    for (const child of Children.toArray((node.props as { children?: ReactNode }).children)) {
      const childText = nodeText(child);
      if (childText === null) return null;
      text += childText;
    }
    return text;
  }
  return null;
}

function markerOnlyKind(node: ReactNode): "pass" | "fail" | null {
  if (!isValidElement(node)) return null;
  const text = nodeText(node);
  if (text === null) return null;
  if (PASS_ONLY.test(text)) return "pass";
  if (FAIL_ONLY.test(text)) return "fail";
  return null;
}

function checklistMarker(children: ReactNode): { kind: "pass" | "fail" | null; rest: ReactNode } {
  const items = Children.toArray(children);
  const first = items[0];
  if (typeof first === "string") {
    const pass = first.match(PASS_PREFIX);
    const fail = pass ? null : first.match(FAIL_PREFIX);
    const match = pass ?? fail;
    if (match) {
      return { kind: pass ? "pass" : "fail", rest: [first.slice(match[0].length), ...items.slice(1)] };
    }
  }
  const firstElementKind = markerOnlyKind(first);
  if (firstElementKind) {
    const rest = items.slice(1);
    if (typeof rest[0] === "string") rest[0] = rest[0].replace(/^\s*[:.—-]?\s*/, "");
    return { kind: firstElementKind, rest };
  }
  const last = items.at(-1);
  if (typeof last === "string") {
    const pass = last.match(PASS_SUFFIX);
    const fail = pass ? null : last.match(FAIL_SUFFIX);
    const match = pass ?? fail;
    if (match) {
      return { kind: pass ? "pass" : "fail", rest: [...items.slice(0, -1), last.slice(0, last.length - match[0].length)] };
    }
  }
  const lastElementKind = markerOnlyKind(last);
  if (lastElementKind) {
    const rest = items.slice(0, -1);
    const beforeLast = rest.at(-1);
    if (typeof beforeLast === "string") rest[rest.length - 1] = beforeLast.replace(/\s*[:—-]\s*$/, "");
    return { kind: lastElementKind, rest };
  }
  return { kind: null, rest: children };
}

function checklistRow(tagName: "p" | "li") {
  // "p" and "li" accept the same attributes we forward; the cast keeps JSX
  // from demanding a single concrete intrinsic element type.
  const Tag = tagName as "p";
  // Loosely typed on purpose: the same component serves Streamdown's `p` and
  // `li` slots, whose prop types differ only in the DOM element generic.
  function ChecklistRow({ node: _node, children, className, ...rawProps }: { node?: unknown; children?: ReactNode; className?: string } & Record<string, unknown>) {
    const props = rawProps as ComponentPropsWithoutRef<"p">;
    const { kind, rest } = checklistMarker(children);
    if (!kind) {
      return <Tag className={className} {...props}>{children}</Tag>;
    }
    return (
      <Tag
        data-testid={kind === "pass" ? "checklist-pass" : "checklist-fail"}
        className={cn(className, "flex items-start gap-1.5", tagName === "li" && "list-none")}
        {...props}
      >
        {kind === "pass" ? (
          <Check aria-label="Satisfied" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
        ) : (
          <X aria-label="Not satisfied" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-600 dark:text-red-400" />
        )}
        <span className="min-w-0">{rest}</span>
      </Tag>
    );
  }
  return ChecklistRow;
}

// Cast: the shared row component is deliberately loose (see above), while
// streamdown's Components maps each tag to its exact DOM element generic.
const CHECKLIST_COMPONENTS = { p: checklistRow("p"), li: checklistRow("li") } as Components;

interface TextBlock {
  type: "text";
  text: string;
}

interface RoledMessage {
  role?: string;
  content?: unknown;
  stopReason?: unknown;
  errorMessage?: unknown;
}

/** The stored turn-level failure of an assistant row (pi stamps stopReason
 * "error" plus errorMessage on the run's final message). Rendered in the
 * transcript so the user learns what went wrong even from persisted history -
 * an errored row often carries no content at all, which used to leave an
 * empty bubble (issue #53 defect 1). */
function assistantError(message: RoledMessage): string | undefined {
  if (message.role !== "assistant" || message.stopReason !== "error") return undefined;
  return typeof message.errorMessage === "string" && message.errorMessage
    ? message.errorMessage
    : "The model request failed.";
}

interface ToolCallBlock {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

function isToolCallBlock(value: unknown): value is ToolCallBlock {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "toolCall" &&
    typeof (value as { id?: unknown }).id === "string" &&
    typeof (value as { name?: unknown }).name === "string"
  );
}

interface ImageBlock {
  type: "image";
  data: string;
  mimeType: string;
}

function isImageBlock(value: unknown): value is ImageBlock {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "image" &&
    typeof (value as { data?: unknown }).data === "string" &&
    typeof (value as { mimeType?: unknown }).mimeType === "string"
  );
}

function isAttachmentReference(value: unknown): value is AttachmentReferenceBlock {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "attachment-reference" &&
    typeof (value as { attachmentId?: unknown }).attachmentId === "string" &&
    typeof (value as { mimeType?: unknown }).mimeType === "string" &&
    ((value as { kind?: unknown }).kind === "user-image" ||
      (value as { kind?: unknown }).kind === "view-sheet")
  );
}

function renderUserContent(content: unknown): ReactNode {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  return content.map((block, index) => {
    if (isTextBlock(block)) return <span key={index}>{block.text}</span>;
    if (isImageBlock(block)) {
      return (
        <img
          key={index}
          data-testid="message-user-image"
          src={`data:${block.mimeType};base64,${block.data}`}
          alt="attached reference"
          className="my-1.5 max-h-32 max-w-full rounded-md object-contain"
        />
      );
    }
    if (isAttachmentReference(block)) {
      return (
        <AttachmentImage
          key={block.attachmentId}
          reference={block}
          testId="message-user-image"
          alt="attached reference"
          className="my-1.5 max-h-32 max-w-full rounded-md object-contain"
        />
      );
    }
    return null;
  });
}

function isTextBlock(value: unknown): value is TextBlock {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "text" &&
    typeof (value as { text?: unknown }).text === "string"
  );
}

/** User/assistant message content is either a plain string or an array of blocks; only text
 * blocks are rendered here (M4 adds tool call/result cards). */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(isTextBlock)
      .map((b) => b.text)
      .join("");
  }
  return "";
}

export interface MessageListProps {
  messages: unknown[];
  streaming: boolean;
  /** The tool currently executing server-side; long CAD tool calls (minutes of
   * stream silence) render as "Running <tool> - <elapsed>" instead of the
   * generic working indicator. */
  activeTool?: ActiveTool;
  /** A prompt was just sent but no live event has returned yet (a cold hosted
   * container can take tens of seconds). Renders a "Starting the agent" hint so
   * the wait never reads as a freeze; supplanted by streaming on the first event. */
  submitting?: boolean;
  /** The just-sent prompt, shown as an optimistic user bubble while submitting;
   * pi's echoed copy replaces it on the first live event. */
  pendingPrompt?: string;
  generationFailed?: boolean;
  /** Extra content (e.g. preset prompt cards) rendered inside the "Start the conversation"
   * empty state; hidden as soon as any user/assistant message exists. */
  emptyState?: ReactNode;
  /** Whether CAD code bodies (tool-call blocks and python fences) are rendered.
   * Hidden by default; ChatPanel threads the CHAMFER_SHOW_CAD_CODE setting here. */
  showCadCode?: boolean;
}

/** How close to the bottom (px) still counts as "pinned" for autoscroll purposes. */
const PIN_THRESHOLD_PX = 40;

function formatElapsed(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds.toString().padStart(2, "0")}s` : `${seconds}s`;
}

/** A turn-level failure rendered inside the transcript (issue #53 defect 1):
 * unmistakably an error, never an empty bubble plus "Done". */
function AssistantErrorNote({ message, className }: { message: string; className?: string }) {
  return (
    <div
      data-testid="assistant-error"
      role="alert"
      className={cn(
        "flex max-w-[80%] items-start gap-1.5 break-words [overflow-wrap:anywhere] rounded-lg border",
        "border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700",
        "dark:border-red-900 dark:bg-red-950 dark:text-red-300",
        className,
      )}
    >
      <CircleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
      <span className="min-w-0">{message}</span>
    </div>
  );
}

/** Live elapsed-time readout for the running tool; re-renders once a second. */
function RunningToolStatus({ tool }: { tool: ActiveTool }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <span data-testid="running-tool">
      Running {toolDisplayName(tool.name)} · {formatElapsed(now - tool.startedAt)}
    </span>
  );
}

export function MessageList({
  messages,
  streaming,
  activeTool,
  submitting = false,
  pendingPrompt,
  generationFailed = false,
  emptyState,
  showCadCode = false,
}: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // Whether the view should follow new content. A ref, not state: scroll events
  // fire per frame and must never re-render, and the autoscroll effects below only
  // read the latest value when content actually changes.
  const pinnedRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const [showJump, setShowJump] = useState(false);

  useEffect(() => {
    if (pinnedRef.current) {
      bottomRef.current?.scrollIntoView({ block: "end" });
    } else {
      setShowJump(true);
    }
  }, [messages, streaming, submitting]);

  // Content can grow without a `messages` identity change (view-sheet images
  // decoding, tool cards expanding, streaming markdown reflow). Watching the
  // content wrapper keeps the view glued through those, not just appends.
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const observer = new ResizeObserver(() => {
      if (pinnedRef.current) bottomRef.current?.scrollIntoView({ block: "end" });
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  function handleScroll(event: React.UIEvent<HTMLDivElement>) {
    const el = event.currentTarget;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    const scrolledUp = el.scrollTop < lastScrollTopRef.current;
    lastScrollTopRef.current = el.scrollTop;
    if (gap < PIN_THRESHOLD_PX) {
      pinnedRef.current = true;
      setShowJump(false);
    } else if (scrolledUp) {
      // Only an upward move away from the bottom is a signal to stop following.
      // Downward scrolls that haven't reached the threshold yet (e.g. the smooth
      // jump-to-latest animation mid-flight) must not unpin, or content landing
      // during the animation strands the view.
      pinnedRef.current = false;
    }
  }

  function jumpToLatest() {
    pinnedRef.current = true;
    setShowJump(false);
    bottomRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }

  const renderable = messages.filter((m) => {
    const role = (m as RoledMessage).role;
    return role === "user" || role === "assistant" || role === "compaction";
  }) as RoledMessage[];
  const toolResults = new Map<string, RoledMessage>();
  for (const message of messages as RoledMessage[]) {
    if (message.role === "toolResult") {
      const toolCallId = (message as { toolCallId?: unknown }).toolCallId;
      if (typeof toolCallId === "string") toolResults.set(toolCallId, message);
    }
  }
  const lastRenderable = renderable.at(-1);
  const generationDone =
    !streaming &&
    !generationFailed &&
    lastRenderable?.role === "assistant" &&
    // An errored turn is not "Done": the error block below tells the story.
    assistantError(lastRenderable) === undefined;

  return (
    <CadCodeVisibilityContext.Provider value={showCadCode}>
    <div className="relative flex min-h-0 flex-1 flex-col">
      {showJump && (
        <button
          type="button"
          data-testid="jump-to-latest"
          onClick={jumpToLatest}
          className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border bg-background/95 px-3 py-1.5 text-xs text-muted-foreground shadow-md backdrop-blur-sm transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
          New messages
        </button>
      )}
      <div
        data-testid="message-list"
        onScroll={handleScroll}
        className="min-h-0 flex-1 overflow-y-auto p-4"
      >
      <div ref={contentRef} className="flex min-h-full flex-col gap-4">
      {renderable.length === 0 && !submitting && (
        <div className="flex flex-1 flex-col items-center justify-center gap-6 text-sm text-muted-foreground">
          <span>Start the conversation</span>
          {emptyState}
        </div>
      )}
      {renderable.map((message, index) => {
        const isUser = message.role === "user";
        const isLast = index === renderable.length - 1;
        const text = extractText(message.content);

        // Compaction rows and injected self-check nudges are transcript metadata, not
        // conversation bubbles: both render as centered system chips.
        if (message.role === "compaction") {
          return (
            <div key={index} className="flex justify-center">
              <span
                data-testid="compaction-marker"
                className="flex items-center gap-1.5 rounded-full border bg-muted/40 px-3 py-1 text-[11px] text-muted-foreground"
              >
                <FoldVertical className="h-3 w-3" aria-hidden="true" />
                Earlier history compacted into a summary for the model - everything stays visible here
              </span>
            </div>
          );
        }
        const toolCalls = Array.isArray(message.content) ? message.content.filter(isToolCallBlock) : [];
        const errorText = assistantError(message);
        // An errored assistant row with nothing else to show renders as the
        // error alone - never as an empty bubble.
        if (errorText !== undefined && text === "" && toolCalls.length === 0) {
          return (
            <div key={index} className="flex min-w-0 justify-start">
              <AssistantErrorNote message={errorText} />
            </div>
          );
        }
        return (
          <div key={index} className={cn("flex min-w-0", isUser ? "justify-end" : "justify-start")}>
            {isUser ? (
              <div className="max-w-[80%] whitespace-pre-wrap break-words [overflow-wrap:anywhere] rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground">
                {renderUserContent(message.content)}
              </div>
            ) : (
              <div className="max-w-[80%] min-w-0 break-words [overflow-wrap:anywhere] rounded-lg bg-muted px-3 py-2 text-sm">
                <Streamdown
                  controls={{ code: { copy: true, download: false } }}
                  plugins={{ renderers: CAD_CODE_RENDERERS, math: MATH_PLUGIN }}
                  components={CHECKLIST_COMPONENTS}
                >
                  {text}
                </Streamdown>
                {toolCalls.map((call) => {
                  const result = toolResults.get(call.id);
                  return (
                    <ToolCallCard
                      key={call.id}
                      call={call}
                      result={result as ToolCallCardResult | undefined}
                      interrupted={generationFailed && isLast && !result}
                      showCadCode={showCadCode}
                    />
                  );
                })}
                {errorText !== undefined && <AssistantErrorNote message={errorText} className="mt-2" />}
                {streaming && isLast && (
                  <span
                    data-testid="streaming-cursor"
                    className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-foreground align-text-bottom"
                  />
                )}
              </div>
            )}
          </div>
        );
      })}
      {submitting && pendingPrompt && (
        <div className="flex min-w-0 justify-end" data-testid="pending-user-message">
          <div className="max-w-[80%] whitespace-pre-wrap break-words [overflow-wrap:anywhere] rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground">
            {pendingPrompt}
          </div>
        </div>
      )}
      {(streaming || submitting || generationDone) && (
        <div
          data-testid="generation-status"
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className={cn(
            "flex h-5 shrink-0 items-center gap-1.5 text-xs",
            streaming || submitting ? "text-muted-foreground" : "text-emerald-600 dark:text-emerald-400",
          )}
        >
          {streaming || submitting ? (
            <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          {streaming && activeTool ? (
            <RunningToolStatus tool={activeTool} />
          ) : (
            <span>
              {streaming ? "Agent is working" : submitting ? "Starting the agent…" : "Done"}
            </span>
          )}
        </div>
      )}
        <div ref={bottomRef} />
      </div>
      </div>
    </div>
    </CadCodeVisibilityContext.Provider>
  );
}
