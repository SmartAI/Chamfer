import { useCallback, useEffect, useRef, useState } from "react";
import { MessageList } from "./MessageList";
import { Composer } from "./Composer";
import { ErrorBanner } from "./ErrorBanner";
import { PresetPrompts } from "./PresetPrompts";
import { DemoQuotaMeter } from "./DemoQuotaMeter";
import { useChatState } from "@/state/chatState";
import { ConnectedFusionDocumentStrip } from "./FusionDocumentStrip";

const SETTINGS_HINT = "Configure a model and API key in Settings to start chatting.";
const HOSTED_AGENT_OFFLINE_HINT =
  "Agent runs are offline on this deployment while Chamfer moves to its new agent runtime.";

export interface ChatPanelProps {
  /** Opens the settings modal (owned by App); feeds the invalid-key banner action. */
  onOpenSettings?: () => void;
}

/**
 * Extracts the text of the most recent user message, used by the rate-limited
 * banner's Retry action.
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
  }
  return undefined;
}

export function ChatPanel({ onOpenSettings }: ChatPanelProps) {
  const {
    activeConversationId,
    conversations,
    sessionState,
    settingsPresent,
    agentHostingOffline,
    error: providerError,
    clearError,
    sendMessage,
    stopAgent,
    modelName,
    missingProviderKey,
    showCadCode,
    demoBudget,
  } = useChatState();

  // The turn is in flight from the moment the prompt is POSTed (submitting) until
  // it settles (streaming); the composer and preset guard treat both as busy.
  const busy = sessionState.streaming || Boolean(sessionState.submitting);

  // Synchronous double-click guard for the preset cards.
  const presetBusyRef = useRef(false);
  const [presetLaunching, setPresetLaunching] = useState(false);

  useEffect(() => {
    if (busy) return;
    presetBusyRef.current = false;
    setPresetLaunching(false);
  }, [activeConversationId, busy]);

  const handleSend = useCallback(
    (text: string, images: File[]) => {
      sendMessage(text, images);
    },
    [sendMessage],
  );

  const retryText = sessionState.error?.kind === "rate-limited" ? lastUserMessageText(sessionState.messages) : undefined;

  const handleRetry = useCallback(() => {
    if (retryText) sendMessage(retryText, []);
  }, [retryText, sendMessage]);

  const handlePresetSelect = useCallback(
    (prompt: string) => {
      if (presetBusyRef.current || busy) return;
      presetBusyRef.current = true;
      setPresetLaunching(true);
      sendMessage(prompt, []);
    },
    [sendMessage, busy],
  );

  const providerErrorBanner = providerError ? (
    <div data-testid="provider-error-banner" className="shrink-0">
      <ErrorBanner error={{ kind: "generic", message: providerError }} onDismiss={clearError} />
    </div>
  ) : null;

  const hostedAgentOfflineBanner = agentHostingOffline ? (
    <div
      data-testid="agent-offline-banner"
      className="shrink-0 border-b bg-amber-50 px-4 py-2 text-xs leading-relaxed text-amber-900 dark:bg-amber-950 dark:text-amber-200"
    >
      {HOSTED_AGENT_OFFLINE_HINT} Run Chamfer locally with{" "}
      <code className="rounded bg-amber-100 px-1 py-0.5 font-mono dark:bg-amber-900">npx chamfer</code> in the
      meantime; your conversations here are kept.
    </div>
  ) : null;

  if (!activeConversationId) {
    return (
      <div className="flex h-full flex-1 flex-col overflow-hidden">
        {hostedAgentOfflineBanner}
        {providerErrorBanner}
        <div className="flex flex-1 flex-col items-center justify-center gap-6">
          <div className="text-center text-sm text-muted-foreground">
            <p className="text-base font-medium text-foreground">No conversation selected</p>
            <p className="mt-1">Start a new chat to choose a CAD environment</p>
          </div>
        </div>
      </div>
    );
  }

  // Provider-aware gate (issue #53): a turn needs a key for the selected
  // model's provider or the deployment's demo quota; without either, the
  // composer is off and the hint names the exact fix.
  const disabled = !settingsPresent || agentHostingOffline || Boolean(missingProviderKey);
  const disabledHint = agentHostingOffline
    ? HOSTED_AGENT_OFFLINE_HINT
    : !settingsPresent
      ? SETTINGS_HINT
      : missingProviderKey
        ? `Add your ${missingProviderKey} API key in Settings to run the selected model.`
        : undefined;

  const activeConversation = conversations.find((c) => c.id === activeConversationId);
  const conversationTitle = activeConversation?.title;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      <div data-testid="chat-header" className="flex min-h-12 shrink-0 items-center gap-2 border-b py-2 pl-4 pr-4 md:pl-12">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{conversationTitle}</p>
        </div>
        {activeConversation && (
          <span
            data-testid="cad-environment-badge"
            title="The CAD environment is fixed for this conversation"
            className="shrink-0 rounded-full border bg-muted/50 px-2.5 py-1 text-[11px] font-medium text-muted-foreground"
          >
            {activeConversation.cadEnvironment === "fusion" ? "Autodesk Fusion" : "Local build123d"}
          </span>
        )}
      </div>
      {activeConversation?.cadEnvironment === "fusion" && (
        <ConnectedFusionDocumentStrip conversation={activeConversation} />
      )}
      {hostedAgentOfflineBanner}
      {providerErrorBanner}
      {sessionState.error && (
        <ErrorBanner
          error={sessionState.error}
          onOpenSettings={onOpenSettings}
          onRetry={retryText && !sessionState.streaming ? handleRetry : undefined}
        />
      )}
      <MessageList
        messages={sessionState.messages}
        streaming={sessionState.streaming}
        submitting={sessionState.submitting}
        pendingPrompt={sessionState.pendingPrompt}
        activeTool={sessionState.activeTool}
        generationFailed={Boolean(sessionState.error)}
        showCadCode={showCadCode}
        emptyState={
          activeConversation?.cadEnvironment === "fusion" ? (
            <div className="max-w-sm text-center text-sm text-muted-foreground">
              <p>Describe the part you want to create or revise in the bound Autodesk Fusion environment.</p>
              <p className="mt-3 text-xs leading-relaxed">
                The native Fusion canvas remains the authoritative interactive 3D view; Chamfer does not mirror the model here.
              </p>
            </div>
          ) : (
            <PresetPrompts disabled={disabled || presetLaunching} onSelect={handlePresetSelect} />
          )
        }
      />
      {demoBudget && <DemoQuotaMeter budget={demoBudget} onOpenSettings={onOpenSettings} />}
      {modelName && (
        <div
          data-testid="agent-status"
          className="flex shrink-0 items-center gap-1.5 border-t px-4 py-1.5 text-[11px] tabular-nums text-muted-foreground"
        >
          <span className="font-medium text-foreground">{modelName}</span>
        </div>
      )}
      <Composer
        disabled={disabled}
        disabledHint={disabledHint}
        streaming={busy}
        onStop={stopAgent}
        onSend={handleSend}
      />
    </div>
  );
}
