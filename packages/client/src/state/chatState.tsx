import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  DEFAULT_CAD_ENVIRONMENT,
  DEFAULT_CONVERSATION_TITLE,
  type CadEnvironment,
  type ConversationDto,
  type OnlineBudgetDto,
} from "@chamfer/shared";
import * as rest from "@/api/rest";
import {
  openAgentEvents,
  postAgentAbort,
  postAgentMessage,
  type AgentImagePayload,
  type AgentStreamEvent,
} from "@/api/agentTransport";
import {
  applyAgentStreamEvent,
  classifySessionError,
  EMPTY_SESSION_STATE,
  type SessionState,
} from "@/state/agentEventFold";
import {
  resolveTurnFundingDisplay,
  type FundingCapabilities,
  type FundingSettings,
} from "@/state/turnFunding";
import { useOptionalAppState } from "@/state/appState";
import { CadEnvironmentDialog } from "@/components/CadEnvironmentDialog";
import { useOptionalFusionReadiness } from "@/state/fusionReadiness";

export type { SessionState } from "@/state/agentEventFold";

const CAD_ENVIRONMENT_PREFERENCE_KEY = "chamfer.cad-environment.v1";
const ACTIVE_CONVERSATION_SESSION_KEY = "chamfer.active-conversation.v1";

function rememberedCadEnvironment(): CadEnvironment {
  try {
    const remembered = localStorage.getItem(CAD_ENVIRONMENT_PREFERENCE_KEY);
    return remembered === "fusion" || remembered === "build123d" ? remembered : DEFAULT_CAD_ENVIRONMENT;
  } catch {
    return DEFAULT_CAD_ENVIRONMENT;
  }
}

// Anthropic recommends a long edge <= 1568 px; larger buys no model fidelity
// and costs tokens. Downscaling here also keeps the persisted message under the
// server's 1 MB conversation-event cap, which a raw phone photo blows past -
// the cause of the "conversation shows in the list but its history won't load"
// bug (the whole turn, including the generated CAD code, failed to persist).
const MAX_IMAGE_EDGE = 1568;
// A file already this small and within the edge limit is sent as-is, preserving
// its format (notably PNG transparency) instead of re-encoding to JPEG.
const DOWNSCALE_BYTE_THRESHOLD = 512 * 1024;

/** Long-edge-capped dimensions preserving aspect ratio. Pure and exported so
 * the scaling contract is unit-tested without a DOM. */
export function scaledDimensions(
  width: number,
  height: number,
  maxEdge: number,
): { width: number; height: number } {
  const longEdge = Math.max(width, height);
  if (longEdge <= maxEdge) return { width, height };
  const ratio = maxEdge / longEdge;
  return { width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio)) };
}

/** Reconstructs an in-memory Blob from an already-read base64 payload, so the
 * downscale decode runs against bytes we hold - never a second read of the
 * OS-backed File. */
function payloadToBlob(payload: AgentImagePayload): Blob {
  const binary = atob(payload.data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: payload.mimeType });
}

/** Downscales+re-encodes an oversized image to JPEG via a canvas, decoding from
 * the bytes we already read (never the File itself). Returns undefined - so the
 * caller keeps the original bytes - when the platform lacks canvas/createImageBitmap
 * (jsdom, older browsers), the decode fails, or the image is already small enough
 * to keep verbatim. `original` carries the source bytes and `byteSize` its size. */
async function downscaleImage(
  original: AgentImagePayload,
  byteSize: number,
): Promise<AgentImagePayload | undefined> {
  if (typeof document === "undefined" || typeof createImageBitmap !== "function") return undefined;
  let bitmap: ImageBitmap;
  try {
    // Decode from an in-memory Blob, not the original File: re-reading the
    // OS-backed File a second time (createImageBitmap after FileReader) throws
    // NotReadableError on real Chrome, whose <input> File reads lazily from disk.
    bitmap = await createImageBitmap(payloadToBlob(original));
  } catch {
    return undefined;
  }
  try {
    const { width, height } = scaledDimensions(bitmap.width, bitmap.height, MAX_IMAGE_EDGE);
    const alreadySmall = width === bitmap.width && height === bitmap.height && byteSize <= DOWNSCALE_BYTE_THRESHOLD;
    if (alreadySmall) return undefined;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return undefined;
    context.drawImage(bitmap, 0, 0, width, height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
    if (!dataUrl.startsWith("data:image/jpeg") || !dataUrl.includes(",")) return undefined;
    return { data: dataUrl.slice(dataUrl.indexOf(",") + 1), mimeType: "image/jpeg" };
  } catch {
    return undefined;
  } finally {
    bitmap.close?.();
  }
}

/** Reads the OS-backed File exactly once, into a base64 data URL. */
function readOriginalImage(file: File): Promise<AgentImagePayload> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read attached image"));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string" || !result.includes(",")) {
        reject(new Error("Attached image did not produce a data URL"));
        return;
      }
      resolve({ data: result.slice(result.indexOf(",") + 1), mimeType: file.type || "image/png" });
    };
    reader.readAsDataURL(file);
  });
}

/** Reads the File once, then downscales from the bytes in hand. Reading the File
 * a second time (the earlier createImageBitmap(file) + FileReader(file) pair) let
 * a large attachment fail the whole turn with a NotReadableError on real Chrome. */
export async function readPromptImage(file: File): Promise<AgentImagePayload> {
  const original = await readOriginalImage(file);
  const downscaled = await downscaleImage(original, file.size).catch(() => undefined);
  return downscaled ?? original;
}

export interface ChatContextValue {
  conversations: ConversationDto[];
  activeConversationId: string | undefined;
  sessionState: SessionState;
  settingsPresent: boolean;
  /** True when this deployment cannot run agent turns at all (the hosted
   * Worker after the pi pivot); ChatPanel shows a notice and disables sends. */
  agentHostingOffline: boolean;
  loading: boolean;
  /** Provider-level failure (conversation create/delete, conversation load);
   * rendered by ChatPanel as a dismissible banner. */
  error: string | null;
  clearError: () => void;
  selectConversation: (id: string) => void;
  /** Opens the CAD-environment dialog; confirming it creates a conversation and switches to it. */
  newConversation: () => void;
  removeConversation: (id: string) => Promise<void>;
  /** Re-fetches /api/settings (e.g. after saving in SettingsModal). */
  refreshSettings: () => Promise<void>;
  /** POSTs a prompt to the server-hosted agent session. */
  sendMessage: (text: string, images: File[]) => void;
  /** Aborts the in-flight agent turn. */
  stopAgent: () => void;
  /** Queues one trusted continuation after an authoritative Fusion reconciliation. */
  resumeAfterFusionReconciliation: (summary: string) => void;
  /** Display label of the model the next turn will actually run (Settings
   * model when funded, demo model "(demo)" when the demo fallback funds it);
   * null when none is configured. */
  modelName: string | null;
  /** Display name of the provider whose missing API key blocks the next turn
   * (issue #53); null when the turn is fundable. ChatPanel gates the composer
   * on it with a hint naming the fix. */
  missingProviderKey: string | null;
  /** Whether chat renders CAD code bodies (CHAMFER_SHOW_CAD_CODE). */
  showCadCode: boolean;
  /** This account's free-demo dollar balance on the hosted deployment, refreshed
   * after every turn; null when the deployment has no demo quota (e.g. local). */
  demoBudget: OnlineBudgetDto | null;
}

/** The funding inputs from one GET /api/settings response: the selected model
 * plus which provider keys exist (values arrive masked; presence is enough). */
function fundingSettingsOf(settings: {
  modelJson?: string;
  anthropicApiKey?: string;
  openaiApiKey?: string;
  googleApiKey?: string;
}): FundingSettings {
  return {
    modelJson: settings.modelJson,
    anthropicApiKey: settings.anthropicApiKey,
    openaiApiKey: settings.openaiApiKey,
    googleApiKey: settings.googleApiKey,
  };
}

/** Exported so tests can render `ChatContext.Provider` directly with a fake value. */
export const ChatContext = createContext<ChatContextValue | undefined>(undefined);

export function ChatProvider({ children }: { children: ReactNode }) {
  const fusionContext = useOptionalFusionReadiness();
  const fusion = {
    enabled: fusionContext?.enabled ?? false,
    readiness: fusionContext?.endpointReadiness,
    integrity: fusionContext?.integrity,
  };
  const appState = useOptionalAppState();
  const loadArtifact = appState?.loadArtifact;
  const clearWorkspace = appState?.clearWorkspace;
  const [conversations, setConversations] = useState<ConversationDto[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | undefined>(undefined);
  const [sessionState, setSessionState] = useState<SessionState>(EMPTY_SESSION_STATE);
  const [settingsPresent, setSettingsPresent] = useState(false);
  const [agentHostingOffline, setAgentHostingOffline] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fundingSettings, setFundingSettings] = useState<FundingSettings>({});
  const [fundingCapabilities, setFundingCapabilities] = useState<FundingCapabilities>({ demoQuota: false });
  const [demoBudget, setDemoBudget] = useState<OnlineBudgetDto | null>(null);
  const [showCadCode, setShowCadCode] = useState(false);
  const [creationOpen, setCreationOpen] = useState(false);
  const [creationEnvironment, setCreationEnvironment] = useState<CadEnvironment>(rememberedCadEnvironment);
  const [creationPending, setCreationPending] = useState(false);
  const [creationError, setCreationError] = useState<string>();
  const creationOpenRef = useRef(false);

  // Guards against a stale async conversation-switch overwriting a newer one.
  const switchTokenRef = useRef(0);
  const eventSourceRef = useRef<EventSource | null>(null);
  // Mirrors agentHostingOffline for the async switchTo/applyAgentEvent paths,
  // so they gate on the freshest capability the probe has resolved rather than
  // the value captured when their callback was built.
  const agentHostingOfflineRef = useRef(false);
  useEffect(() => () => eventSourceRef.current?.close(), []);
  const didRestoreInitialConversationRef = useRef(false);
  // One title-generation attempt per conversation per visit.
  const titleAttemptedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    rest
      .getSettings()
      .then((settings) => {
        if (cancelled) return;
        setSettingsPresent(Boolean(settings.modelJson));
        setFundingSettings(fundingSettingsOf(settings));
        setShowCadCode(settings.showCadCode === "1");
      })
      .catch(() => {
        // Leave settingsPresent false; switchTo re-fetches settings.
      });
    rest
      .getRuntimeCapabilities()
      .then((capabilities) => {
        if (cancelled) return;
        agentHostingOfflineRef.current = !capabilities.agentHosting;
        setAgentHostingOffline(!capabilities.agentHosting);
        setFundingCapabilities({ demoQuota: capabilities.demoQuota, demoModel: capabilities.demoModel });
        // Seed the demo balance once we know this deployment funds keyless turns;
        // deployments without demo quota never mount the route (the fetch nulls).
        if (capabilities.demoQuota) {
          void rest.getOnlineBudget().then((budget) => {
            if (!cancelled) setDemoBudget(budget);
          });
        }
      })
      .catch(() => {
        // The probe is advisory; on failure assume capable so chat still works.
      });
    rest
      .listConversations()
      .then((list) => {
        if (!cancelled) setConversations(list);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /** Folds one server-sent agent event into the visible session state. The
   * folding rule itself lives in agentEventFold.ts (pure, unit-tested): turn
   * status keys only on agent_start / agent_settled / agent_status /
   * agent_error, never on agent_end (continuations follow it), message-level
   * events, or stream silence. */
  const applyAgentEvent = useCallback((conversationId: string, event: AgentStreamEvent) => {
    if (event.type === "artifact_updated") {
      void loadArtifact?.(conversationId);
      // The conversation just produced a model; mark it so the sidebar dot turns
      // green now, without waiting for the next full conversation-list fetch.
      setConversations((prev) =>
        prev.map((c) => (c.id === conversationId && !c.hasArtifact ? { ...c, hasArtifact: true } : c)));
      return;
    }
    setSessionState((current) => applyAgentStreamEvent(current, event));
  }, [loadArtifact]);

  const switchTo = useCallback((id: string | undefined, conversationOverride?: ConversationDto) => {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;

    const token = ++switchTokenRef.current;
    setActiveConversationId(id);
    try {
      if (id) sessionStorage.setItem(ACTIVE_CONVERSATION_SESSION_KEY, id);
      else sessionStorage.removeItem(ACTIVE_CONVERSATION_SESSION_KEY);
    } catch {
      // Session restoration is a convenience and must not block navigation.
    }
    if (id) titleAttemptedRef.current.delete(id);
    setSessionState(EMPTY_SESSION_STATE);
    clearWorkspace?.();

    if (!id) return;
    void conversationOverride;

    Promise.all([rest.getSettings(), rest.listMessages(id)])
      .then(([settings, messages]) => {
        if (cancelled()) return;
        setSettingsPresent(Boolean(settings.modelJson));
        setFundingSettings(fundingSettingsOf(settings));
        setShowCadCode(settings.showCadCode === "1");

        const priorMessages = messages
          .slice()
          .sort((a, b) => a.seq - b.seq)
          .map((message) => JSON.parse(message.contentJson) as unknown);
        setSessionState({ messages: priorMessages, streaming: false });

        // Deployments that don't host the agent (agentHosting:false) serve the
        // conversation as read-only history: the /api/agent/*/events and
        // /artifact routes 404, so subscribing and fetching would only spend a
        // DO round-trip to log phantom failures. Skip both entirely there.
        if (agentHostingOfflineRef.current) return;

        // Live-only stream: persisted history above covers everything earlier.
        eventSourceRef.current = openAgentEvents(id, (event) => {
          if (cancelled()) return;
          applyAgentEvent(id, event);
        });

        // Restore the latest exported artifact into the viewer, if one exists.
        void loadArtifact?.(id);
      })
      .catch((err: unknown) => {
        if (cancelled()) return;
        setError(err instanceof Error ? err.message : String(err));
      });

    function cancelled() {
      return switchTokenRef.current !== token;
    }
  }, [applyAgentEvent, clearWorkspace, loadArtifact]);

  useEffect(() => {
    if (loading || didRestoreInitialConversationRef.current) return;
    if (activeConversationId) return;
    let rememberedId: string | null = null;
    try {
      rememberedId = sessionStorage.getItem(ACTIVE_CONVERSATION_SESSION_KEY);
    } catch {
      // A storage-restricted tab starts without an active conversation.
    }
    didRestoreInitialConversationRef.current = true;
    if (rememberedId && conversations.some((conversation) => conversation.id === rememberedId)) {
      switchTo(rememberedId);
      return;
    }
    if (rememberedId) {
      try { sessionStorage.removeItem(ACTIVE_CONVERSATION_SESSION_KEY); } catch { /* stale key is harmless */ }
    }
    const localConversation = conversations.find((conversation) => conversation.cadEnvironment === "build123d");
    if (localConversation) {
      switchTo(localConversation.id);
    }
  }, [activeConversationId, conversations, loading, switchTo]);

  // Auto-title: once the conversation has an assistant reply and streaming is
  // over, ask the server to summarize the first exchange into a title.
  useEffect(() => {
    const id = activeConversationId;
    if (!id || sessionState.streaming) return;
    const conversation = conversations.find((c) => c.id === id);
    if (!conversation || conversation.title !== DEFAULT_CONVERSATION_TITLE) return;
    const hasAssistantReply = sessionState.messages.some(
      (m) => typeof m === "object" && m !== null && (m as { role?: unknown }).role === "assistant",
    );
    if (!hasAssistantReply) return;
    if (titleAttemptedRef.current.has(id)) return;
    titleAttemptedRef.current.add(id);
    rest
      .generateTitle(id)
      .then(({ title }) => {
        setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, title } : c)));
      })
      .catch(() => {
        // Title generation is best-effort; never surface it as a chat error.
      });
  }, [activeConversationId, conversations, sessionState]);

  // Re-read the free-demo balance when a turn finishes streaming: the server
  // debits it once the run settles, so the meter is stale until then. Gated on
  // demoBudget having been seeded, so non-demo deployments never poll the route.
  const wasStreamingRef = useRef(false);
  useEffect(() => {
    const streaming = sessionState.streaming;
    const justFinished = wasStreamingRef.current && !streaming;
    wasStreamingRef.current = streaming;
    if (!justFinished || demoBudget === null) return;
    void rest.getOnlineBudget().then((budget) => {
      if (budget) setDemoBudget(budget);
    });
  }, [sessionState.streaming, demoBudget]);

  const sendMessage = useCallback(
    (text: string, images: File[]) => {
      const id = activeConversationId;
      if (!id) return;
      // Optimistically show the user's prompt and a "starting" hint the instant
      // they hit send. On a cold hosted container the first stream event is tens
      // of seconds out; without this the screen sits unchanged and reads as
      // frozen. Held as pendingPrompt (not appended to messages) so pi's own echo
      // of the prompt, which arrives once the turn starts, replaces it cleanly
      // instead of duplicating it - the fold clears it on the first live event.
      setSessionState((current) => ({
        ...current,
        submitting: true,
        pendingPrompt: text,
        error: undefined,
      }));
      void (async () => {
        const payloads = await Promise.all(images.map(readPromptImage));
        await postAgentMessage(id, text, payloads);
      })().catch((err: unknown) => {
        setSessionState((current) => ({
          ...current,
          submitting: false,
          pendingPrompt: undefined,
          error: classifySessionError(err instanceof Error ? err.message : String(err)),
        }));
      });
    },
    [activeConversationId],
  );

  const stopAgent = useCallback(() => {
    const id = activeConversationId;
    if (!id) return;
    void postAgentAbort(id).catch(() => {
      // Abort is best-effort; the turn also ends on its own.
    });
  }, [activeConversationId]);

  const resumeAfterFusionReconciliation = useCallback((summary: string) => {
    const id = activeConversationId;
    if (!id) return;
    void postAgentAbort(id).catch(() => undefined);
    sendMessage(
      `Fusion changed outside this chat and the new state was accepted: ${summary}. ` +
        "Re-inspect the live document state, discard stale assumptions, and continue the request from there.",
      [],
    );
  }, [activeConversationId, sendMessage]);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  const selectConversation = useCallback(
    (id: string) => {
      didRestoreInitialConversationRef.current = true;
      switchTo(id);
    },
    [switchTo],
  );

  const newConversation = useCallback((): void => {
    if (creationOpenRef.current) return;
    creationOpenRef.current = true;
    didRestoreInitialConversationRef.current = true;
    setError(null);
    setCreationError(undefined);
    const remembered = rememberedCadEnvironment();
    setCreationEnvironment(fusion.enabled ? remembered : DEFAULT_CAD_ENVIRONMENT);
    setCreationOpen(true);
  }, [fusion.enabled]);

  const cancelConversationCreation = useCallback(() => {
    if (creationPending) return;
    creationOpenRef.current = false;
    setCreationOpen(false);
    setCreationError(undefined);
  }, [creationPending]);

  const createBoundConversation = useCallback(async (
    cadEnvironment: CadEnvironment,
  ): Promise<ConversationDto> => {
    const created = await rest.createConversation(DEFAULT_CONVERSATION_TITLE, cadEnvironment);
    if (cadEnvironment !== "fusion") return created;
    try {
      await rest.bindFusionDocument(created.id);
      return created;
    } catch (bindingError) {
      await rest.deleteConversation(created.id).catch(() => undefined);
      throw bindingError;
    }
  }, []);

  const confirmConversationCreation = useCallback(async () => {
    if (creationPending || !creationOpenRef.current) return;
    setCreationPending(true);
    setCreationError(undefined);
    try {
      const created = await createBoundConversation(creationEnvironment);
      try {
        localStorage.setItem(CAD_ENVIRONMENT_PREFERENCE_KEY, creationEnvironment);
      } catch {
        // A blocked storage preference must not block explicit creation.
      }
      creationOpenRef.current = false;
      setError(null);
      setConversations((prev) => [created, ...prev]);
      setCreationOpen(false);
      switchTo(created.id, created);
      return created.id;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setCreationError(message);
      setError(message);
    } finally {
      setCreationPending(false);
    }
  }, [createBoundConversation, creationEnvironment, creationPending, switchTo]);

  const refreshSettings = useCallback(async () => {
    try {
      const settings = await rest.getSettings();
      setSettingsPresent(Boolean(settings.modelJson));
      setFundingSettings(fundingSettingsOf(settings));
      setShowCadCode(settings.showCadCode === "1");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const removeConversation = useCallback(
    async (id: string) => {
      setError(null);
      try {
        await rest.deleteConversation(id);
        setConversations((prev) => prev.filter((c) => c.id !== id));
        if (activeConversationId === id) {
          switchTo(undefined);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [activeConversationId, switchTo],
  );

  const funding = useMemo(
    () => resolveTurnFundingDisplay(fundingSettings, fundingCapabilities),
    [fundingSettings, fundingCapabilities],
  );

  const value = useMemo<ChatContextValue>(
    () => ({
      conversations,
      activeConversationId,
      sessionState,
      settingsPresent,
      agentHostingOffline,
      loading,
      error,
      clearError,
      selectConversation,
      newConversation,
      removeConversation,
      refreshSettings,
      sendMessage,
      stopAgent,
      resumeAfterFusionReconciliation,
      modelName: funding.modelName,
      missingProviderKey: funding.missingProviderKey,
      showCadCode,
      demoBudget,
    }),
    [
      conversations,
      activeConversationId,
      sessionState,
      settingsPresent,
      agentHostingOffline,
      loading,
      error,
      clearError,
      selectConversation,
      newConversation,
      removeConversation,
      refreshSettings,
      sendMessage,
      stopAgent,
      resumeAfterFusionReconciliation,
      funding,
      showCadCode,
      demoBudget,
    ],
  );

  return (
    <ChatContext.Provider value={value}>
      {children}
      <CadEnvironmentDialog
        open={creationOpen}
        value={creationEnvironment}
        creating={creationPending}
        error={creationError}
        onValueChange={setCreationEnvironment}
        onConfirm={() => void confirmConversationCreation()}
        onCancel={cancelConversationCreation}
        fusionEnabled={fusion.enabled}
        fusionReadiness={fusion.readiness}
        fusionIntegrity={fusion.integrity}
      />
    </ChatContext.Provider>
  );
}

export function useChatState(): ChatContextValue {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error("useChatState must be used within a ChatProvider");
  return ctx;
}
