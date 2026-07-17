import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Clock, Send, X } from "lucide-react";
import { turnStats } from "@/agent/turnStats";
import { MessageList } from "./MessageList";
import { Composer } from "./Composer";
import { ErrorBanner } from "./ErrorBanner";
import { PresetPrompts } from "./PresetPrompts";
import { VerificationChip } from "./VerificationChip";
import { PlanCard } from "./PlanCard";
import { SourceSpecificationsCard } from "./SourceSpecificationsCard";
import { ProofContractCard } from "./ProofContractCard";
import { DesignEscalationCard } from "./DesignEscalationCard";
import { ReferenceRegistrationsCard } from "./ReferenceRegistrationsCard";
import { ProofReportCard } from "./ProofReportCard";
import { latestGateSummary } from "@/agent/gateSummary";
import { latestPlan } from "@/agent/plan";
import { currentProofContract } from "@/agent/proofContract";
import { currentVisualVerification } from "@/agent/visualVerification";
import { FUSION_RECONCILIATION_MARKER, PLAN_NUDGE_MARKER, SELF_CHECK_MARKER } from "@/agent/session";
import { useChatState } from "@/state/chatState";
import { useOptionalAppState } from "@/state/appState";
import { effectiveProofReport } from "@/agent/proofReport";
import { ResultFeedback } from "./ResultFeedback";
import { ConnectedFusionDocumentStrip } from "./FusionDocumentStrip";

const SETTINGS_HINT = "Configure a model and API key in Settings to start chatting.";

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
    // Injected self-check and plan nudges are user-role messages but not the user's
    // prompt; retrying one would just re-ask the agent to checklist itself.
    if (text?.startsWith(SELF_CHECK_MARKER) || text?.startsWith(PLAN_NUDGE_MARKER) || text?.startsWith(FUSION_RECONCILIATION_MARKER)) continue;
    return text;
  }
  return undefined;
}

export function ChatPanel({ onOpenSettings }: ChatPanelProps) {
  const currentArtifact = useOptionalAppState()?.currentArtifact ?? null;
  const {
    activeConversationId,
    conversations,
    session,
    sessionState,
    settingsPresent,
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
    showCadCode,
  } = useChatState();

  const stats = useMemo(() => turnStats(sessionState.messages), [sessionState.messages]);

  // Synchronous double-click guard: React state re-renders too late to stop a second click
  // arriving before the first one's state update has flushed.
  const presetBusyRef = useRef(false);
  const [presetLaunching, setPresetLaunching] = useState(false);

  // Re-arm the preset cards whenever no turn is streaming.
  useEffect(() => {
    if (sessionState.streaming) return;
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
      if (presetBusyRef.current || !session || sessionState.streaming) return;
      presetBusyRef.current = true;
      setPresetLaunching(true);
      void session.send(prompt, []).finally(() => {
        presetBusyRef.current = false;
        setPresetLaunching(false);
      });
    },
    [session, sessionState.streaming],
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
            <p className="mt-1">Start a new chat to choose a CAD environment</p>
          </div>
        </div>
      </div>
    );
  }

  // Streaming no longer disables the composer: sends during a turn steer the active run.
  const disabled = !settingsPresent || !session;
  const disabledHint = !settingsPresent ? SETTINGS_HINT : undefined;

  const activeConversation = conversations.find((c) => c.id === activeConversationId);
  const conversationTitle = activeConversation?.title;
  const plan = latestPlan(sessionState.messages);
  const proofContract = currentProofContract(
    sessionState.proofContracts ?? [],
    plan,
    sessionState.referenceRegistrations ?? [],
  );
  const proofReport = effectiveProofReport(sessionState.proofReports ?? [], {
    plan,
    contract: proofContract,
    sourceSpecifications: sessionState.sourceSpecifications ?? [],
    referenceRegistrations: sessionState.referenceRegistrations ?? [],
    activeReferenceIds: (sessionState.referenceRecords ?? [])
      .filter((record) => record.status === "active" || record.status === "complementary")
      .map((record) => record.referenceId),
    visualVerification: currentVisualVerification(sessionState.messages, sessionState.referenceRecords ?? []),
    artifact: currentArtifact,
  });
  const designEscalation = sessionState.designEscalations?.at(-1);
  const hasAssistantResult = sessionState.messages.some((message) =>
    (message as { role?: string }).role === "assistant"
  );

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      <div data-testid="chat-header" className="flex min-h-12 shrink-0 items-center gap-2 border-b py-2 pl-12 pr-4">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{conversationTitle}</span>
        {activeConversation && (
          <span
            data-testid="cad-environment-badge"
            title="The CAD environment is fixed for this conversation"
            className="shrink-0 rounded-full border bg-muted/50 px-2.5 py-1 text-[11px] font-medium text-muted-foreground"
          >
            {activeConversation.cadEnvironment === "fusion" ? "Autodesk Fusion" : "Local build123d"}
          </span>
        )}
        <VerificationChip
          streaming={sessionState.streaming}
          summary={latestGateSummary(sessionState.messages)}
          visual={currentVisualVerification(sessionState.messages, sessionState.referenceRecords ?? [])}
          proofState={proofReport?.status}
        />
      </div>
      {activeConversation?.cadEnvironment === "fusion" && (
        <ConnectedFusionDocumentStrip conversation={activeConversation} />
      )}
      {(sessionState.sourceSpecifications ?? []).length > 0 && (
        <SourceSpecificationsCard specifications={sessionState.sourceSpecifications ?? []} />
      )}
      {designEscalation && <DesignEscalationCard escalation={designEscalation} />}
      {(sessionState.referenceRegistrations ?? []).length > 0 && (
        <ReferenceRegistrationsCard registrations={sessionState.referenceRegistrations ?? []} />
      )}
      {proofContract && <ProofContractCard contract={proofContract} />}
      {proofReport && <ProofReportCard report={proofReport} />}
      {plan && <PlanCard plan={plan} sourceSpecifications={sessionState.sourceSpecifications ?? []} />}
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
        showCadCode={showCadCode}
        emptyState={
          activeConversation?.cadEnvironment === "fusion" ? (
            <div className="max-w-sm text-center text-sm text-muted-foreground">
              <p>Describe the part you want to create or revise in the bound Autodesk Fusion environment.</p>
              <p className="mt-3 text-xs leading-relaxed">
                The native Fusion canvas remains the authoritative interactive 3D view; Chamfer does not mirror the model here.
              </p>
              <p data-testid="fusion-provider-disclosure" className="mt-2 text-xs leading-relaxed">
                Selected Fusion evidence is processed by your configured model provider. Chamfer sends only the bound design's necessary engineering snapshot, relevant installed API excerpts, selected views, and normalized action results—not Fusion files, unrelated documents or projects, credentials, or raw MCP traffic.
              </p>
            </div>
          ) : (
            // No disabledHint here: the composer directly below already explains
            // why everything is disabled; repeating the sentence reads as a bug.
            <PresetPrompts disabled={disabled || presetLaunching} onSelect={handlePresetSelect} />
          )
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
      {!sessionState.streaming && hasAssistantResult && (
        <div className="flex shrink-0 justify-end border-t px-4 py-1.5">
          <ResultFeedback conversationId={activeConversationId} resultKey={sessionState.messages.length} />
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
          {activeConversation?.cadEnvironment !== "fusion" && (
            <>
              <span aria-hidden="true">·</span>
              <span>
                CAD runs {stats.cadRunsThisTurn} / {maxCadRuns}
              </span>
            </>
          )}
          {sessionState.notice?.kind === "retrying" && (
            <>
              <span aria-hidden="true">·</span>
              <span data-testid="retry-notice" className="text-amber-600 dark:text-amber-400">
                request interrupted, retrying in {sessionState.notice.delaySeconds}s (attempt{" "}
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
