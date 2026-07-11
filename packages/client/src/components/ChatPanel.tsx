import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Clock, Send, X } from "lucide-react";
import { turnStats } from "@/agent/turnStats";
import { MessageList } from "./MessageList";
import { Composer } from "./Composer";
import { ErrorBanner } from "./ErrorBanner";
import { PresetPrompts } from "./PresetPrompts";
import { VerificationChip } from "./VerificationChip";
import { latestGateSummary } from "@/agent/gateSummary";
import { SELF_CHECK_MARKER } from "@/agent/session";
import { useChatState } from "@/state/chatState";

const SETTINGS_HINT = "Configure a model and API key in Settings to start chatting.";

interface PendingPreset {
  prompt: string;
  /** null until createConversation resolves; the send effect only fires once a session
   * for exactly this conversation exists, so a preset can never land in the wrong chat. */
  conversationId: string | null;
}

export interface ChatPanelProps {
  /** Opens the settings modal (owned by App); feeds the invalid-key banner action. */
  onOpenSettings?: () => void;
}

/**
 * Extracts the text of the most recent user message from the session's message list,
 * used by the rate-limited banner's Retry action. User messages carry either a plain
 * string or a content-block array whose first text block holds the prompt.
 */
function lastUserMessageText(messages: unknown[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: string; content?: unknown };
    if (message?.role !== "user") continue;
    let text: string | undefined;
    if (typeof message.content === "string") text = message.content;
    else if (Array.isArray(message.content)) {
      const textBlock = message.content.find(
        (block: { type?: string }) => block?.type === "text",
      ) as { text?: string } | undefined;
      text = textBlock?.text;
    }
    // Injected self-check nudges are user-role messages but not the user's prompt;
    // retrying one would just re-ask the agent to checklist itself.
    if (text?.startsWith(SELF_CHECK_MARKER)) continue;
    return text;
  }
  return undefined;
}

export function ChatPanel({ onOpenSettings }: ChatPanelProps) {
  const {
    activeConversationId,
    conversations,
    session,
    sessionState,
    settingsPresent,
    newConversation,
    error: providerError,
    clearError,
    queuedMessages,
    queuePaused,
    sendMessage,
    stopAgent,
    removeQueued,
    sendQueuedNow,
    modelName,
    maxCadRuns,
  } = useChatState();

  const stats = useMemo(() => turnStats(sessionState.messages), [sessionState.messages]);

  // A preset chosen from the no-conversation state must wait for newConversation()'s async
  // switch to produce a live ChatSession; the prompt is stashed here and sent by the effect
  // below once the created conversation's session appears.
  const pendingPresetRef = useRef<PendingPreset | null>(null);
  // Synchronous double-click guard: React state re-renders too late to stop a second click
  // arriving before the first one's state update has flushed.
  const presetBusyRef = useRef(false);
  const [presetLaunching, setPresetLaunching] = useState(false);

  useEffect(() => {
    if (!session) return;
    const pending = pendingPresetRef.current;
    if (!pending || pending.conversationId === null) return;
    // A session appeared: either for the conversation this preset created (send it) or for
    // another conversation the user opened during the create window (drop the preset).
    pendingPresetRef.current = null;
    presetBusyRef.current = false;
    setPresetLaunching(false);
    if (session.conversationId === pending.conversationId) {
      void session.send(pending.prompt, []);
    }
  }, [session]);

  // Re-arm the preset cards whenever no turn is streaming and no launch is pending
  // (e.g. after a conversation switch or a completed/failed turn).
  useEffect(() => {
    if (sessionState.streaming || pendingPresetRef.current) return;
    presetBusyRef.current = false;
    setPresetLaunching(false);
  }, [activeConversationId, sessionState.streaming]);

  const handleSend = useCallback(
    (text: string, images: File[]) => {
      sendMessage(text, images);
    },
    [sendMessage],
  );

  const retryText = sessionState.error?.kind === "rate-limited" ? lastUserMessageText(sessionState.messages) : undefined;

  const handleRetry = useCallback(() => {
    if (retryText) void session?.send(retryText);
  }, [retryText, session]);

  const handlePresetSelect = useCallback(
    (prompt: string) => {
      if (presetBusyRef.current || pendingPresetRef.current) return;
      if (session) {
        if (sessionState.streaming) return;
        presetBusyRef.current = true;
        setPresetLaunching(true);
        void session.send(prompt, []);
        return;
      }
      // Arm synchronously so a rapid second click cannot create a second conversation.
      presetBusyRef.current = true;
      pendingPresetRef.current = { prompt, conversationId: null };
      setPresetLaunching(true);
      newConversation()
        .then((id) => {
          const pending = pendingPresetRef.current;
          if (pending && pending.prompt === prompt && pending.conversationId === null) {
            pendingPresetRef.current = { prompt, conversationId: id };
          }
        })
        .catch(() => {
          // Creation failed (rendered by the provider-error banner above): disarm so the
          // preset cannot fire into whatever conversation is opened next.
          pendingPresetRef.current = null;
          presetBusyRef.current = false;
          setPresetLaunching(false);
        });
    },
    [newConversation, session, sessionState.streaming],
  );

  // Provider-level failures (conversation create/delete, conversation load, artifact
  // persistence) live outside any session, so they get their own dismissible banner
  // above the session error banner.
  const providerErrorBanner = providerError ? (
    <div data-testid="provider-error-banner" className="shrink-0">
      <ErrorBanner error={{ kind: "generic", message: providerError }} onDismiss={clearError} />
    </div>
  ) : null;

  if (!activeConversationId) {
    return (
      <div className="flex h-full flex-1 flex-col overflow-hidden">
        {providerErrorBanner}
        <div className="flex flex-1 flex-col items-center justify-center gap-6">
          <div className="text-center text-sm text-muted-foreground">
            <p className="text-base font-medium text-foreground">No conversation selected</p>
            <p className="mt-1">Start a new chat to begin</p>
          </div>
          <PresetPrompts
            disabled={!settingsPresent || presetLaunching}
            disabledHint={!settingsPresent ? SETTINGS_HINT : undefined}
            onSelect={handlePresetSelect}
          />
        </div>
      </div>
    );
  }

  // Streaming no longer disables the composer: sends during a turn join the queue.
  const disabled = !settingsPresent || !session;
  const disabledHint = !settingsPresent ? SETTINGS_HINT : undefined;

  const conversationTitle = conversations.find((c) => c.id === activeConversationId)?.title;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      <div data-testid="chat-header" className="flex min-h-12 shrink-0 items-center gap-2 border-b py-2 pl-12 pr-4">
        <span className="min-w-0 truncate text-sm font-medium">{conversationTitle}</span>
        <VerificationChip
          streaming={sessionState.streaming}
          summary={latestGateSummary(sessionState.messages)}
        />
      </div>
      {providerErrorBanner}
      {sessionState.error && (
        <ErrorBanner
          error={sessionState.error}
          onOpenSettings={onOpenSettings}
          onRetry={session && retryText && !sessionState.streaming ? handleRetry : undefined}
        />
      )}
      <MessageList
        messages={sessionState.messages}
        streaming={sessionState.streaming}
        generationFailed={Boolean(sessionState.error)}
        emptyState={
          // No disabledHint here: the composer directly below already explains
          // why everything is disabled; repeating the sentence reads as a bug.
          <PresetPrompts disabled={disabled || presetLaunching} onSelect={handlePresetSelect} />
        }
      />
      {queuedMessages.length > 0 && (
        <div data-testid="queue-strip" className="flex shrink-0 flex-col gap-1.5 border-t px-3 pt-2">
          {queuePaused && (
            <p data-testid="queue-paused" className="text-xs text-muted-foreground">
              Queue paused — send a queued message below or type a new one to resume.
            </p>
          )}
          {queuedMessages.map((message) => (
            <div
              key={message.id}
              data-testid="queued-message"
              className="flex items-center gap-2 rounded-md border bg-muted/40 px-2 py-1.5 text-xs"
            >
              <Clock className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">{message.text}</span>
              <button
                type="button"
                data-testid="queued-send-now"
                aria-label="Send now"
                title="Send now"
                onClick={() => sendQueuedNow(message.id)}
                className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Send className="h-3 w-3" />
              </button>
              <button
                type="button"
                data-testid="queued-remove"
                aria-label="Remove from queue"
                title="Remove from queue"
                onClick={() => removeQueued(message.id)}
                className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}
      {modelName && (
        <div
          data-testid="agent-status"
          className="flex shrink-0 items-center gap-1.5 border-t px-4 py-1.5 text-[11px] tabular-nums text-muted-foreground"
        >
          <span className="font-medium text-foreground">{modelName}</span>
          <span aria-hidden="true">·</span>
          <span>LLM calls {stats.llmCalls}</span>
          <span aria-hidden="true">·</span>
          <span>
            CAD runs {stats.cadRunsThisTurn} / {maxCadRuns}
          </span>
          {sessionState.notice?.kind === "retrying" && (
            <>
              <span aria-hidden="true">·</span>
              <span data-testid="retry-notice" className="text-amber-600 dark:text-amber-400">
                rate-limited, retrying in {sessionState.notice.delaySeconds}s (attempt{" "}
                {sessionState.notice.attempt} of {sessionState.notice.maxAttempts})
              </span>
            </>
          )}
          {sessionState.notice?.kind === "compacting" && (
            <>
              <span aria-hidden="true">·</span>
              <span data-testid="compacting-notice">compacting context…</span>
            </>
          )}
        </div>
      )}
      <Composer
        disabled={disabled}
        disabledHint={disabledHint}
        streaming={sessionState.streaming}
        onStop={stopAgent}
        onSend={handleSend}
      />
    </div>
  );
}
