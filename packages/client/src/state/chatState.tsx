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
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { DEFAULT_CONVERSATION_TITLE, type ConversationDto } from "@chamfer/shared";
import * as rest from "@/api/rest";
import { createSession, registerMessagePersistenceId, type ChatSession, type SessionState } from "@/agent/session";
import { latestGateSummary } from "@/agent/gateSummary";
import { systemPrompt } from "@/agent/prompt";
import { createRunBuild123dTool } from "@/agent/tools/runBuild123d";
import { createLookupDocsTool } from "@/agent/tools/lookupDocs";
import { useOptionalAppState } from "@/state/appState";

const EMPTY_SESSION_STATE: SessionState = { messages: [], streaming: false };

export interface ChatContextValue {
  conversations: ConversationDto[];
  activeConversationId: string | undefined;
  session: ChatSession | null;
  sessionState: SessionState;
  settingsPresent: boolean;
  loading: boolean;
  /** Provider-level failure (conversation create/delete, conversation load, artifact
   * persistence); rendered by ChatPanel as a dismissible banner. */
  error: string | null;
  /** Dismisses the provider-level error banner. */
  clearError: () => void;
  selectConversation: (id: string) => void;
  /** Creates a conversation, switches to it, and resolves with its id; rejects on REST
   * failure (after surfacing the error) so callers can disarm any pending follow-up. */
  newConversation: () => Promise<string>;
  removeConversation: (id: string) => Promise<void>;
  /** Re-fetches /api/settings (e.g. after saving in SettingsModal) so settings-gated UI
   * such as the preset prompt cards enables without a reload. */
  refreshSettings: () => Promise<void>;
}

/** Exported so tests can render `ChatContext.Provider` directly with a fake value (e.g. a
 * scripted fake `ChatSession`) instead of going through `ChatProvider`'s real REST/session
 * wiring. */
export const ChatContext = createContext<ChatContextValue | undefined>(undefined);

export interface ChatProviderProps {
  children: ReactNode;
  /**
   * Internal test-only override for session creation. Production callers must not set this;
   * it exists so tests can inject a fake ChatSession (e.g. to assert abort() behavior) without
   * mocking the whole agent/session module, mirroring session.ts's __streamFn seam.
   */
  __createSession?: typeof createSession;
}

export function ChatProvider({ children, __createSession }: ChatProviderProps) {
  const appState = useOptionalAppState();
  if (!appState && !__createSession) {
    throw new Error("ChatProvider must be used within an AppStateProvider");
  }
  const cad = appState?.cad ?? null;
  const publishCadResult = appState?.publishCadResult;
  const restoreScript = appState?.restoreScript;
  const clearWorkspace = appState?.clearWorkspace;
  const runScript = appState?.runScript;
  const [conversations, setConversations] = useState<ConversationDto[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | undefined>(undefined);
  const [session, setSession] = useState<ChatSession | null>(null);
  const [sessionState, setSessionState] = useState<SessionState>(EMPTY_SESSION_STATE);
  const [settingsPresent, setSettingsPresent] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const buildSession = __createSession ?? createSession;

  // Guards against a stale async conversation-switch overwriting a newer one.
  const switchTokenRef = useRef(0);

  // Tracks the live ChatSession instance outside React state so switchTo (a useCallback with
  // empty deps) can always abort the actual outgoing session instead of a stale closure over
  // `session`. Updated everywhere setSession is called.
  const sessionRef = useRef<ChatSession | null>(null);
  const didRestoreInitialConversationRef = useRef(false);
  // One title-generation attempt per conversation per *visit*: a failure keeps
  // the default title for the rest of the current view (no render-driven retry
  // loop against the LLM), and switchTo re-arms the id so clicking the
  // conversation again retries.
  const titleAttemptedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    // Settings are also fetched on mount (not only inside switchTo) so the no-conversation
    // empty state knows whether the preset prompt cards can start a chat.
    rest
      .getSettings()
      .then((settings) => {
        if (cancelled) return;
        setSettingsPresent(Boolean(settings.modelJson));
      })
      .catch(() => {
        // Leave settingsPresent false; switchTo re-fetches settings and surfaces errors.
      });
    rest
      .listConversations()
      .then((list) => {
        if (cancelled) return;
        setConversations(list);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const switchTo = useCallback((id: string | undefined) => {
    // Abort whatever session is currently live before tearing it down: an in-flight agent
    // turn must not keep streaming headless (burning tokens, persisting messages to a
    // possibly-deleted conversation) after the user navigates away from it.
    sessionRef.current?.abort();

    const token = ++switchTokenRef.current;
    setActiveConversationId(id);
    // Re-arm auto-titling for this conversation: a generation that failed on a
    // previous visit gets another attempt now that the user opened it again.
    if (id) titleAttemptedRef.current.delete(id);
    sessionRef.current = null;
    setSession(null);
    setSessionState(EMPTY_SESSION_STATE);
    // CAD output is conversation scoped. Clear the mesh, measurements,
    // parameters, and script before restoring the target artifact below.
    if (clearWorkspace) clearWorkspace();
    else restoreScript?.(null);

    if (!id) return;

    Promise.all([rest.getSettings(), rest.listMessages(id), rest.listArtifacts(id)])
      .then(async ([settings, messages, artifacts]) => {
        if (cancelled()) return;

        const modelJson = settings.modelJson;
        setSettingsPresent(Boolean(modelJson));

        const priorMessages = messages
          .slice()
          .sort((a, b) => a.seq - b.seq)
          .map((m) => {
            const parsed = JSON.parse(m.contentJson) as unknown;
            registerMessagePersistenceId(parsed, m.id);
            return parsed;
          });

        // History remains readable even before model credentials are set.
        setSessionState({ messages: priorMessages, streaming: false });

        if (modelJson) {
          // During the CAD boot window (cad === null) the session is built without
          // run_build123d; lookup_docs is always available.
          const tools: AgentTool[] = [createLookupDocsTool()];
          if (cad && publishCadResult) {
            tools.unshift(
              createRunBuild123dTool({
                cad,
                onSuccess: async ({ code, mesh, measurements }) => {
                  publishCadResult({ mesh, measurements });
                  restoreScript?.(code);
                  try {
                    await rest.postArtifact(id, { pySource: code, paramsJson: null });
                  } catch (artifactError) {
                    setError(artifactError instanceof Error ? artifactError.message : String(artifactError));
                  }
                },
              }),
            );
          }

          // Settings values travel as strings; the session falls back to its
          // built-in cap when the value is missing or not a positive integer.
          const parsedMaxCadRuns = Number(settings.maxCadRuns);
          const maxCadRuns =
            Number.isInteger(parsedMaxCadRuns) && parsedMaxCadRuns > 0 ? parsedMaxCadRuns : undefined;

          const newSession = buildSession({
            conversationId: id,
            modelJson,
            systemPrompt,
            tools,
            priorMessages,
            maxCadRuns,
          });
          sessionRef.current = newSession;
          setSession(newSession);
        }

        // Message replay is already visible. Rendering the latest artifact can
        // now take as long as needed without blocking the conversation.
        if (Array.isArray(artifacts) && artifacts.length > 0) {
          const latest = artifacts.reduce((a, b) => (b.version > a.version ? b : a));
          if (cad && runScript) await runScript(latest.pySource);
          else restoreScript?.(latest.pySource);
        }
      })
      .catch((err: unknown) => {
        if (cancelled()) return;
        setError(err instanceof Error ? err.message : String(err));
      });

    function cancelled() {
      return switchTokenRef.current !== token;
    }
  }, [buildSession, cad, clearWorkspace, publishCadResult, restoreScript, runScript]);

  useEffect(() => {
    if (loading || didRestoreInitialConversationRef.current) return;
    if (__createSession) return;
    if (!activeConversationId && conversations[0]) {
      // Burn the ref only when a restore actually happens: the first non-loading
      // render can see an empty list, and consuming the one-shot there would
      // disable restoration for conversations that appear later.
      didRestoreInitialConversationRef.current = true;
      switchTo(conversations[0].id);
    }
  }, [__createSession, activeConversationId, conversations, loading, switchTo]);

  useEffect(() => {
    if (!session) return;
    const unsubscribe = session.subscribe((state) => {
      setSessionState(state);
    });
    return unsubscribe;
  }, [session]);

  // Auto-title: once the conversation has an assistant reply and streaming is
  // over, ask the server to summarize the first exchange into a title. Titles
  // are exclusively server-generated (there is no rename endpoint); only
  // conversations still carrying the creation default are eligible, so a
  // previously generated title is never regenerated. Failures are non-fatal:
  // the sidebar keeps the default title until the conversation is opened again.
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

  // Keep the sidebar's gate dot live for the active conversation: the server rolls the
  // verdict up on message persistence, but the already-fetched list would only show it
  // after a reload. Once a turn finishes, mirror the session's latest verdict locally.
  useEffect(() => {
    const id = activeConversationId;
    if (!id || sessionState.streaming) return;
    const status = latestGateSummary(sessionState.messages)?.status;
    if (!status) return;
    setConversations((prev) => {
      const target = prev.find((c) => c.id === id);
      if (!target || target.lastGateStatus === status) return prev;
      return prev.map((c) => (c.id === id ? { ...c, lastGateStatus: status } : c));
    });
  }, [activeConversationId, sessionState]);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  const selectConversation = useCallback(
    (id: string) => {
      switchTo(id);
    },
    [switchTo],
  );

  const newConversation = useCallback(async () => {
    setError(null);
    try {
      const created = await rest.createConversation(DEFAULT_CONVERSATION_TITLE);
      setConversations((prev) => [created, ...prev]);
      switchTo(created.id);
      return created.id;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }, [switchTo]);

  const refreshSettings = useCallback(async () => {
    try {
      const settings = await rest.getSettings();
      const present = Boolean(settings.modelJson);
      setSettingsPresent(present);
      // A conversation opened before a model was configured never had its session built
      // (switchTo bails without modelJson); re-switch to build it now. There is no live
      // session to abort in that case.
      if (present && activeConversationId && !sessionRef.current) {
        switchTo(activeConversationId);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [activeConversationId, switchTo]);

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

  const value = useMemo<ChatContextValue>(
    () => ({
      conversations,
      activeConversationId,
      session,
      sessionState,
      settingsPresent,
      loading,
      error,
      clearError,
      selectConversation,
      newConversation,
      removeConversation,
      refreshSettings,
    }),
    [
      conversations,
      activeConversationId,
      session,
      sessionState,
      settingsPresent,
      loading,
      error,
      clearError,
      selectConversation,
      newConversation,
      removeConversation,
      refreshSettings,
    ],
  );

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export function useChatState(): ChatContextValue {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error("useChatState must be used within a ChatProvider");
  return ctx;
}
