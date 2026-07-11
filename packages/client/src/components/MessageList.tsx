import { useEffect, useRef, useState, type ReactNode } from "react";
import { Streamdown, type CustomRendererProps } from "streamdown";
import { ArrowDown, CheckCircle2, FoldVertical, ListChecks, LoaderCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { ToolCallCard, type ToolCallCardResult } from "./ToolCallCard";
import { getMessagePersistenceId, SELF_CHECK_MARKER } from "@/agent/session";
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
  // Whether the view should follow new content. A ref, not state: scroll events
  // fire per frame and must never re-render, and the autoscroll effect below only
  // reads the latest value when content actually changes.
  const pinnedRef = useRef(true);
  const [showJump, setShowJump] = useState(false);

  useEffect(() => {
    if (pinnedRef.current) {
      bottomRef.current?.scrollIntoView({ block: "end" });
    } else {
      setShowJump(true);
    }
  }, [messages, streaming]);

  function handleScroll(event: React.UIEvent<HTMLDivElement>) {
    const el = event.currentTarget;
    const pinned = el.scrollHeight - el.scrollTop - el.clientHeight < PIN_THRESHOLD_PX;
    pinnedRef.current = pinned;
    if (pinned) setShowJump(false);
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
        className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4"
      >
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
  );
}
