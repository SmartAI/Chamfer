import { useCallback, useEffect, useRef, useState } from "react";
import { MessageList } from "./MessageList";
import { Composer } from "./Composer";
import { ErrorBanner } from "./ErrorBanner";
import { PresetPrompts } from "./PresetPrompts";
import { VerificationChip } from "./VerificationChip";
import { latestGateSummary } from "@/agent/gateSummary";
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
    if (typeof message.content === "string") return message.content;
    if (Array.isArray(message.content)) {
      const textBlock = message.content.find(
        (block: { type?: string }) => block?.type === "text",
      ) as { text?: string } | undefined;
      return textBlock?.text;
    }
    return undefined;
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
  } = useChatState();

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
      void session?.send(text, images);
    },
    [session],
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

  const disabled = !settingsPresent || !session || sessionState.streaming;
  const disabledHint = !settingsPresent
    ? SETTINGS_HINT
    : sessionState.streaming
      ? "Waiting for the response to finish..."
      : undefined;

  const conversationTitle = conversations.find((c) => c.id === activeConversationId)?.title;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      <div data-testid="chat-header" className="flex shrink-0 items-center gap-2 border-b px-4 py-2">
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
          <PresetPrompts
            disabled={disabled || presetLaunching}
            disabledHint={disabledHint}
            onSelect={handlePresetSelect}
          />
        }
      />
      <Composer disabled={disabled} disabledHint={disabledHint} onSend={handleSend} />
    </div>
  );
}
