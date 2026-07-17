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
import {
  DEFAULT_CAD_ENVIRONMENT,
  DEFAULT_CONVERSATION_TITLE,
  type CadEnvironment,
  type ConversationDto,
} from "@chamfer/shared";
import * as rest from "@/api/rest";
import {
  createSession,
  FUSION_RECONCILIATION_MARKER,
  registerMessagePersistenceId,
  DEFAULT_MAX_CAD_RUNS,
  type ChatSession,
  type SessionState,
} from "@/agent/session";
import { latestGateSummary } from "@/agent/gateSummary";
import { PROBE_COMPONENT, runComponentIds } from "@/agent/plan";
import { resolveAblationSkill } from "@/agent/ablation";
import { evaluationTraceIdentity } from "@/agent/agentRunLifecycle";
import { assembleAgentPrompt } from "@/agent/build123dSkill";
import { runtimePrompt } from "@/agent/prompt";
import { fusionRuntimePrompt } from "@/agent/fusionPrompt";
import { createSearchFusionDocsTool } from "@/agent/tools/searchFusionDocs";
import { createInspectFusionTool } from "@/agent/tools/inspectFusion";
import { createRunBuild123dTool } from "@/agent/tools/runBuild123d";
import { createLookupDocsTool } from "@/agent/tools/lookupDocs";
import { createSearchDocsTool } from "@/agent/tools/searchDocs";
import { useOptionalAppState } from "@/state/appState";
import { CadEnvironmentDialog } from "@/components/CadEnvironmentDialog";
import { useOptionalFusionReadiness } from "@/state/fusionReadiness";

const EMPTY_SESSION_STATE: SessionState = {
  messages: [],
  referenceRecords: [],
  sourceSpecifications: [],
  proofContracts: [],
  proofReports: [],
  designEscalations: [],
  referenceRegistrations: [],
  streaming: false,
};
const CAD_ENVIRONMENT_PREFERENCE_KEY = "chamfer.cad-environment.v1";

function rememberedCadEnvironment(): CadEnvironment {
  try {
    const remembered = localStorage.getItem(CAD_ENVIRONMENT_PREFERENCE_KEY);
    return remembered === "fusion" || remembered === "build123d" ? remembered : DEFAULT_CAD_ENVIRONMENT;
  } catch {
    return DEFAULT_CAD_ENVIRONMENT;
  }
}

/** A message the user sent while the agent was busy, waiting for its own turn. */
export interface QueuedMessage {
  id: string;
  text: string;
  images: File[];
}

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
  /** Opens the CAD-environment dialog; confirming it creates a conversation and switches to it. */
  newConversation: () => void;
  removeConversation: (id: string) => Promise<void>;
  /** Re-fetches /api/settings (e.g. after saving in SettingsModal) so settings-gated UI
   * such as the preset prompt cards enables without a reload. */
  refreshSettings: () => Promise<void>;
  /** Messages pending pi consumption or waiting for an idle recovery send, in send order. */
  queuedMessages: QueuedMessage[];
  /** True after stopAgent(): queued messages stay put until the user resumes
   * (by sending anything, or sendQueuedNow on a specific item). */
  queuePaused: boolean;
  /** Sends a new run when idle and steers the active pi run when streaming. */
  sendMessage: (text: string, images: File[]) => void;
  /** Aborts the in-flight turn and pauses queue draining. */
  stopAgent: () => void;
  /** Cancels stale work and queues one trusted continuation after an unambiguous
   * authoritative Fusion reconciliation. */
  resumeAfterFusionReconciliation: (summary: string) => void;
  /** Drops a queued message without sending it. */
  removeQueued: (id: string) => void;
  /** Moves a queued message to the front and resumes draining. */
  sendQueuedNow: (id: string) => void;
  /** Display name of the configured model (null when none is configured). */
  modelName: string | null;
  /** Effective run_build123d cap per turn (settings value or the default). */
  maxCadRuns: number;
  /** Whether chat renders CAD code bodies (CHAMFER_SHOW_CAD_CODE / the showCadCode
   * setting). Hidden by default. */
  showCadCode: boolean;
}

/** Display name from a settings modelJson payload; null when absent or unparseable. */
function modelNameOf(modelJson: string | undefined): string | null {
  if (!modelJson) return null;
  try {
    const parsed = JSON.parse(modelJson) as { name?: unknown; id?: unknown };
    if (typeof parsed.name === "string" && parsed.name) return parsed.name;
    if (typeof parsed.id === "string" && parsed.id) return parsed.id;
  } catch {
    // Fall through: a corrupt modelJson simply shows no model.
  }
  return null;
}

/** Effective per-turn CAD-run cap from the string-encoded setting. */
function capOf(maxCadRuns: string | undefined): number {
  const parsed = Number(maxCadRuns);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_CAD_RUNS;
}

/** Whether the string-encoded showCadCode setting turns code bodies on. */
function showCadCodeOf(showCadCode: string | undefined): boolean {
  return showCadCode === "1";
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
  const fusionContext = useOptionalFusionReadiness();
  const fusion = {
    enabled: fusionContext?.enabled ?? false,
    readiness: fusionContext?.endpointReadiness,
    integrity: fusionContext?.integrity,
  };
  const appState = useOptionalAppState();
  if (!appState && !__createSession) {
    throw new Error("ChatProvider must be used within an AppStateProvider");
  }
  const cad = appState?.cad ?? null;
  const publishCadResult = appState?.publishCadResult;
  const restoreScript = appState?.restoreScript;
  const setCurrentArtifact = appState?.setCurrentArtifact;
  const clearWorkspace = appState?.clearWorkspace;
  const runScript = appState?.runScript;
  const [conversations, setConversations] = useState<ConversationDto[]>([]);
  const conversationsRef = useRef<ConversationDto[]>([]);
  conversationsRef.current = conversations;
  const [activeConversationId, setActiveConversationId] = useState<string | undefined>(undefined);
  const [session, setSession] = useState<ChatSession | null>(null);
  const [sessionState, setSessionState] = useState<SessionState>(EMPTY_SESSION_STATE);
  const [settingsPresent, setSettingsPresent] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessage[]>([]);
  const [queuePaused, setQueuePaused] = useState(false);
  const [modelName, setModelName] = useState<string | null>(null);
  const [maxCadRuns, setMaxCadRuns] = useState<number>(DEFAULT_MAX_CAD_RUNS);
  const [showCadCode, setShowCadCode] = useState(false);
  const [creationOpen, setCreationOpen] = useState(false);
  const [creationEnvironment, setCreationEnvironment] = useState<CadEnvironment>(rememberedCadEnvironment);
  const [creationPending, setCreationPending] = useState(false);
  const [creationError, setCreationError] = useState<string>();
  const creationOpenRef = useRef(false);
  // True from a send() call until its promise settles (the real session resolves send()
  // only when the whole agent turn is done). Guards the drain effect against firing a
  // second send into a turn whose streaming flag has not propagated yet.
  const sendInFlightRef = useRef(false);
  const steeringInFlightRef = useRef(new Set<string>());
  // Bumped when a send settles, so the drain effect re-runs even though a promise
  // resolution alone triggers no render.
  const [drainTick, setDrainTick] = useState(0);

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
        setModelName(modelNameOf(settings.modelJson));
        setMaxCadRuns(capOf(settings.maxCadRuns));
        setShowCadCode(showCadCodeOf(settings.showCadCode));
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

  const switchTo = useCallback((id: string | undefined, conversationOverride?: ConversationDto) => {
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
    steeringInFlightRef.current.clear();
    setSession(null);
    setSessionState(EMPTY_SESSION_STATE);
    // The queue is conversation-scoped: messages typed for one conversation must
    // never fire into another.
    setQueuedMessages([]);
    setQueuePaused(false);
    // CAD output is conversation scoped. Clear the mesh, measurements,
    // parameters, and script before restoring the target artifact below.
    if (clearWorkspace) clearWorkspace();
    else restoreScript?.(null);

    if (!id) return;

    Promise.all([
      rest.getConversation(id),
      rest.getSettings(),
      rest.listMessages(id),
      rest.listArtifacts(id),
      rest.listReferenceRecords(id),
      rest.listOpenInspectionLeases(id),
      rest.listVisualVerifications(id),
      rest.listVisualVerificationBatches(id),
      rest.listSourceSpecifications(id),
      rest.listProofContracts(id),
      rest.listProofReports(id),
      rest.listDesignEscalations(id),
      rest.listReferenceRegistrations(id),
    ])
      .then(async ([
        loadedConversation,
        settings,
        messages,
        artifacts,
        referenceRecords,
        openInspectionLeases,
        visualVerifications,
        visualVerificationBatches,
        sourceSpecifications,
        proofContracts,
        proofReports,
        designEscalations,
        referenceRegistrations,
      ]) => {
        if (cancelled()) return;
        const conversation = conversationOverride ?? loadedConversation;

        const modelJson = settings.modelJson;
        setSettingsPresent(Boolean(modelJson));
        setModelName(modelNameOf(modelJson));
        setMaxCadRuns(capOf(settings.maxCadRuns));
        setShowCadCode(showCadCodeOf(settings.showCadCode));

        const priorMessages = messages
          .slice()
          .sort((a, b) => a.seq - b.seq)
          .map((m) => {
            const parsed = JSON.parse(m.contentJson) as unknown;
            registerMessagePersistenceId(parsed, m.id);
            return parsed;
          });
        const nextMessageSeq = messages.length === 0
          ? 0
          : messages.reduce((maximum, message) => Math.max(maximum, message.seq), -1) + 1;

        // History remains readable even before model credentials are set.
        setSessionState({
          messages: priorMessages,
          referenceRecords,
          sourceSpecifications,
          proofContracts,
          proofReports,
          designEscalations,
          referenceRegistrations,
          streaming: false,
        });

        if (modelJson) {
          // Every conversation receives exactly one environment catalog.
          const tools: AgentTool[] = conversation.cadEnvironment === "build123d"
            ? [createLookupDocsTool(), createSearchDocsTool()]
            : [
                createSearchFusionDocsTool({ search: rest.searchFusionDocumentation }),
                createInspectFusionTool({ inspect: (checks) => rest.inspectFusionDocument(id, checks) }),
              ];
          if (conversation.cadEnvironment === "build123d" && cad && publishCadResult) {
            tools.unshift(
              createRunBuild123dTool({
                cad,
                onSuccess: async ({ code, mesh, measurements }) => {
                  // Probe runs (COMPONENT = "probe") are diagnostics the agent uses to
                  // interrogate the gate; they must never displace the deliverable in
                  // the viewer, the script panel, or the artifact store.
                  const declaration = runComponentIds(measurements);
                  if (declaration?.length === 1 && declaration[0] === PROBE_COMPONENT) return;
                  publishCadResult({ mesh, measurements });
                  restoreScript?.(code);
                  try {
                    const artifact = await rest.postArtifact(id, { pySource: code, paramsJson: null });
                    setCurrentArtifact?.({ id: artifact.id, version: artifact.version });
                    return { artifactId: artifact.id, artifactVersion: artifact.version };
                  } catch (artifactError) {
                    setError(artifactError instanceof Error ? artifactError.message : String(artifactError));
                    return undefined;
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

          const skillMode = conversation.cadEnvironment === "build123d"
            ? resolveAblationSkill(window.location.search, import.meta.env.DEV)
            : "none";
          const newSession = buildSession({
            conversationId: id,
            cadEnvironment: conversation.cadEnvironment,
            modelJson,
            systemPrompt: conversation.cadEnvironment === "build123d"
              ? assembleAgentPrompt(runtimePrompt, { skill: skillMode })
              : fusionRuntimePrompt,
            tools,
            priorMessages,
            nextMessageSeq,
            referenceRecords,
            openInspectionLeases,
            visualVerifications,
            visualVerificationBatches,
            sourceSpecifications,
            proofContracts,
            proofReports,
            designEscalations,
            referenceRegistrations,
            sourceSpecificationsRequired: conversation?.sourceSpecificationsRequired === true,
            maxCadRuns,
            skillMode,
            executeFusionAction: conversation.cadEnvironment === "fusion"
              ? (input, signal) => rest.executeFusionAction(id, input, signal)
              : undefined,
            evaluationIdentity: evaluationTraceIdentity(window.location.search),
          });
          sessionRef.current = newSession;
          setSession(newSession);
        }

        // Message replay is already visible. Rendering the latest artifact can
        // now take as long as needed without blocking the conversation.
        if (conversation.cadEnvironment === "build123d" && Array.isArray(artifacts) && artifacts.length > 0) {
          const latest = artifacts.reduce((a, b) => (b.version > a.version ? b : a));
          if (cad && runScript) {
            const restored = await runScript(latest.pySource);
            if (restored) setCurrentArtifact?.({ id: latest.id, version: latest.version });
          } else {
            restoreScript?.(latest.pySource);
            setCurrentArtifact?.({ id: latest.id, version: latest.version });
          }
        }
      })
      .catch((err: unknown) => {
        if (cancelled()) return;
        setError(err instanceof Error ? err.message : String(err));
      });

    function cancelled() {
      return switchTokenRef.current !== token;
    }
  }, [buildSession, cad, clearWorkspace, publishCadResult, restoreScript, runScript, setCurrentArtifact]);

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

  /** Fires a send on the live session and keeps the in-flight guard accurate for
   * the whole turn (send() resolves when the turn is fully over). */
  const dispatchSend = useCallback((text: string, images: File[]) => {
    const live = sessionRef.current;
    if (!live) return;
    sendInFlightRef.current = true;
    void live.send(text, images).finally(() => {
      sendInFlightRef.current = false;
      setDrainTick((tick) => tick + 1);
    });
  }, []);

  const dispatchSteering = useCallback((message: QueuedMessage) => {
    const live = sessionRef.current;
    if (!live || steeringInFlightRef.current.has(message.id)) return;
    steeringInFlightRef.current.add(message.id);
    void live.steer(message.id, message.text, message.images).then((outcome) => {
      steeringInFlightRef.current.delete(message.id);
      if (outcome === "consumed") {
        setQueuedMessages((prev) => prev.filter((candidate) => candidate.id !== message.id));
      }
      setDrainTick((tick) => tick + 1);
    }).catch(() => {
      steeringInFlightRef.current.delete(message.id);
      setDrainTick((tick) => tick + 1);
    });
  }, []);

  const sendMessage = useCallback(
    (text: string, images: File[]) => {
      if (!sessionRef.current) return;
      // Any explicit send is the user asking for the agent to run again, so a
      // Stop-induced pause ends here.
      setQueuePaused(false);
      if (sessionState.streaming || sendInFlightRef.current) {
        const message = { id: crypto.randomUUID(), text, images };
        setQueuedMessages((prev) => [...prev, message]);
        if (sessionState.streaming) dispatchSteering(message);
        return;
      }
      dispatchSend(text, images);
    },
    [dispatchSend, dispatchSteering, sessionState.streaming],
  );

  const stopAgent = useCallback(() => {
    // Pause before aborting: abort synchronously flips streaming off inside the same
    // batch, and the drain effect must already see the pause when it re-runs.
    setQueuePaused(true);
    sessionRef.current?.abort();
  }, []);

  const resumeAfterFusionReconciliation = useCallback((summary: string) => {
    if (!sessionRef.current) return;
    const message: QueuedMessage = {
      id: crypto.randomUUID(),
      text: `${FUSION_RECONCILIATION_MARKER} Fusion changed outside Chamfer and trusted inspection accepted the new engineering state: ${summary}. Re-inspect the current evidence, discard stale plan assumptions, and continue the user's unfinished request from this authoritative revision.`,
      images: [],
    };
    // Abort first so no stale tool call can cross the revision boundary. Queue
    // draining resumes only after the active send promise settles.
    sessionRef.current.abort();
    setQueuedMessages((prev) => [...prev, message]);
    setQueuePaused(false);
  }, []);

  const removeQueued = useCallback((id: string) => {
    sessionRef.current?.cancelSteering(id);
    steeringInFlightRef.current.delete(id);
    setQueuedMessages((prev) => prev.filter((message) => message.id !== id));
  }, []);

  const sendQueuedNow = useCallback((id: string) => {
    // Move to the front and resume; the drain effect below delivers it as soon as
    // the agent is idle (immediately, when nothing is in flight).
    setQueuedMessages((prev) => {
      const chosen = prev.find((message) => message.id === id);
      if (!chosen) return prev;
      return [chosen, ...prev.filter((message) => message.id !== id)];
    });
    sessionRef.current?.prioritizeSteering(id);
    setQueuePaused(false);
  }, []);

  // Busy-session delivery uses pi steering. Messages remain in queuedMessages so
  // pending controls stay visible until the session reports consumption.
  useEffect(() => {
    if (!sessionState.streaming || queuePaused || sessionState.error) return;
    for (const message of queuedMessages) dispatchSteering(message);
  }, [dispatchSteering, queuePaused, queuedMessages, sessionState.error, sessionState.streaming]);

  // Queue drain: whenever the agent is idle, nothing is paused or errored, and a
  // message is waiting, send exactly one. Each drained turn re-triggers this effect
  // via drainTick when it settles, delivering the rest FIFO.
  useEffect(() => {
    void drainTick;
    if (sessionState.streaming || sendInFlightRef.current) return;
    if (queuePaused || sessionState.error) return;
    const next = queuedMessages[0];
    if (!next || !sessionRef.current) return;
    if (steeringInFlightRef.current.has(next.id)) return;
    setQueuedMessages((prev) => prev.slice(1));
    dispatchSend(next.text, next.images);
  }, [dispatchSend, drainTick, queuePaused, queuedMessages, sessionState]);

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
    // A direct user action wins over the mount-time auto-restore effect, even
    // when the conversation list and create request resolve in the same frame.
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

  const confirmConversationCreation = useCallback(async () => {
    if (creationPending || !creationOpenRef.current) return;
    setCreationPending(true);
    setCreationError(undefined);
    try {
      const created = await rest.createConversation(DEFAULT_CONVERSATION_TITLE, creationEnvironment);
      if (creationEnvironment === "fusion") {
        try {
          await rest.bindFusionDocument(created.id);
        } catch (bindingError) {
          // Do not leave an unbound Fusion conversation behind when trusted
          // inspection or endpoint ownership rejects creation.
          await rest.deleteConversation(created.id).catch(() => undefined);
          throw bindingError;
        }
      }
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
  }, [creationEnvironment, creationPending, switchTo]);

  const refreshSettings = useCallback(async () => {
    try {
      const settings = await rest.getSettings();
      const present = Boolean(settings.modelJson);
      setSettingsPresent(present);
      setModelName(modelNameOf(settings.modelJson));
      setMaxCadRuns(capOf(settings.maxCadRuns));
      setShowCadCode(showCadCodeOf(settings.showCadCode));
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
      queuedMessages,
      queuePaused,
      sendMessage,
      stopAgent,
      resumeAfterFusionReconciliation,
      removeQueued,
      sendQueuedNow,
      modelName,
      maxCadRuns,
      showCadCode,
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
      queuedMessages,
      queuePaused,
      sendMessage,
      stopAgent,
      resumeAfterFusionReconciliation,
      removeQueued,
      sendQueuedNow,
      modelName,
      maxCadRuns,
      showCadCode,
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
