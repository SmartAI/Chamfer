import { Children, isValidElement, useEffect, useRef, useState, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { Streamdown, type Components, type CustomRendererProps } from "streamdown";
import { ArrowDown, Check, CheckCircle2, FoldVertical, ListChecks, LoaderCircle, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { ToolCallCard, type ToolCallCardResult } from "./ToolCallCard";
import { getMessagePersistenceId, PLAN_NUDGE_MARKER, SELF_CHECK_MARKER } from "@/agent/session";
import { CadCodeActions } from "./CadCodeActions";

function PythonCodeBlock({ code, language, isIncomplete }: CustomRendererProps) {
  return (
    <div className="my-2 overflow-hidden rounded-md border bg-background">
      <div className="flex items-center justify-between border-b bg-muted/40 px-2 py-1.5">
        <span className="font-mono text-[11px] text-muted-foreground">{language || "python"}</span>
        <CadCodeActions code={code} disabled={isIncomplete} />
      </div>
      <pre className="max-h-72 overflow-auto p-3 font-mono text-xs leading-5">
        <code>{code}</code>
      </pre>
    </div>
  );
}

const CAD_CODE_RENDERERS = [{ language: ["python", "py"], component: PythonCodeBlock }];

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
  generationFailed?: boolean;
  /** Extra content (e.g. preset prompt cards) rendered inside the "Start the conversation"
   * empty state; hidden as soon as any user/assistant message exists. */
  emptyState?: ReactNode;
}

/** How close to the bottom (px) still counts as "pinned" for autoscroll purposes. */
const PIN_THRESHOLD_PX = 40;

export function MessageList({ messages, streaming, generationFailed = false, emptyState }: MessageListProps) {
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
  }, [messages, streaming]);

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
  const generationDone =
    !streaming &&
    !generationFailed &&
    renderable.at(-1)?.role === "assistant";

  return (
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
      {renderable.length === 0 && (
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
        if (isUser && text.startsWith(SELF_CHECK_MARKER)) {
          return (
            <div key={index} className="flex justify-center">
              <span
                data-testid="self-check-chip"
                className="flex items-center gap-1.5 rounded-full border bg-muted/40 px-3 py-1 text-[11px] text-muted-foreground"
              >
                <ListChecks className="h-3 w-3" aria-hidden="true" />
                Self-check: confirming every part of the request is built
              </span>
            </div>
          );
        }
        if (isUser && text.startsWith(PLAN_NUDGE_MARKER)) {
          return (
            <div key={index} className="flex justify-center">
              <span
                data-testid="plan-nudge-chip"
                className="flex items-center gap-1.5 rounded-full border bg-muted/40 px-3 py-1 text-[11px] text-muted-foreground"
              >
                <ListChecks className="h-3 w-3" aria-hidden="true" />
                Plan check: unfinished components remain — continuing the build
              </span>
            </div>
          );
        }
        const toolCalls = Array.isArray(message.content) ? message.content.filter(isToolCallBlock) : [];
        // User image blocks are persisted verbatim in contentJson (base64 included), so
        // replayed messages render straight from the content blocks; no attachment fetch.
        const images = isUser && Array.isArray(message.content) ? message.content.filter(isImageBlock) : [];

        return (
          <div key={index} className={cn("flex min-w-0", isUser ? "justify-end" : "justify-start")}>
            {isUser ? (
              <div className="max-w-[80%] whitespace-pre-wrap break-words [overflow-wrap:anywhere] rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground">
                {images.length > 0 && (
                  <div className="mb-1.5 flex flex-wrap gap-1.5">
                    {images.map((image, imageIndex) => (
                      <img
                        key={imageIndex}
                        data-testid="message-user-image"
                        src={`data:${image.mimeType};base64,${image.data}`}
                        alt="attached reference"
                        className="max-h-32 max-w-full rounded-md object-contain"
                      />
                    ))}
                  </div>
                )}
                {text}
              </div>
            ) : (
              <div className="max-w-[80%] min-w-0 break-words [overflow-wrap:anywhere] rounded-lg bg-muted px-3 py-2 text-sm">
                <Streamdown
                  controls={{ code: { copy: true, download: false } }}
                  plugins={{ renderers: CAD_CODE_RENDERERS }}
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
                      resultMessageId={getMessagePersistenceId(result)}
                    />
                  );
                })}
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
      {(streaming || generationDone) && (
        <div
          data-testid="generation-status"
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className={cn(
            "flex h-5 shrink-0 items-center gap-1.5 text-xs",
            streaming ? "text-muted-foreground" : "text-emerald-600 dark:text-emerald-400",
          )}
        >
          {streaming ? (
            <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          <span>{streaming ? "Agent is working" : "Done"}</span>
        </div>
      )}
        <div ref={bottomRef} />
      </div>
      </div>
    </div>
  );
}
