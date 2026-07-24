import { mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Api, Model } from "@earendil-works/pi-ai";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import type { CadEnvironment } from "@chamfer/shared";
import { getConversation } from "../conversationStore";
import { appendStoredMessages, persistTurnTranscript, seedSessionFromStore } from "./turnPersistence";
import { readEffectiveSettings } from "../settingsStore";
import { resolveProviderConfig } from "../providerConfig";
import {
  BUILD123D_DIRECT_TOOLS,
  FUSION_DIRECT_TOOLS,
  mcpAdapterExtensionPath,
  writeBuild123dMcpConfig,
  writeFusionMcpConfig,
} from "./mcpTools";
import { AgentStatusTracker, type AgentRunStatus, type AgentServerEvent } from "./agentStatus";
import {
  conversationAgentDir,
  LocalArtifactStore,
  observeExport,
  type ArtifactStore,
} from "./artifactStore";
import { systemPromptFor } from "./prompts";

export type { AgentRunStatus, AgentServerEvent } from "./agentStatus";

interface Channel {
  subscribers: Set<(event: AgentServerEvent) => void>;
}

interface ConversationAgent {
  session: AgentSession;
  environment: CadEnvironment;
  dir: string;
}

function providerOf(model: unknown): string | undefined {
  return typeof model === "object" && model !== null && typeof (model as { provider?: unknown }).provider === "string"
    ? (model as { provider: string }).provider
    : undefined;
}

/** Hosts one pi AgentSession per conversation. CAD tools come from
 * pi-mcp-adapter loaded as a pi extension against a server-generated
 * `.mcp.json` in the conversation's working directory; pi's native session,
 * queueing, and compaction machinery is used as-is. Conversation history
 * persistence stays in the Chamfer sqlite store. */
export class PiAgentSessions {
  private readonly agents = new Map<string, Promise<ConversationAgent>>();
  private readonly channels = new Map<string, Channel>();
  private readonly statuses = new Map<string, AgentStatusTracker>();
  /** Serialized content of user rows persisted eagerly by recordPrompt and not
   * yet consumed by an agent_end; persistTurnTranscript skips exactly these so
   * the run's copy is not double-stored. */
  private readonly pendingEagerUserContent = new Map<string, string[]>();
  private modelRuntime: Promise<ModelRuntime> | undefined;
  /** Serializes session creation: pi-mcp-adapter reads its config relative to
   * process.cwd() at extension-load time, so creation chdirs briefly. */
  private creationChain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly db: DatabaseSync,
    private readonly dataDir: string,
    private readonly artifactStore: ArtifactStore = new LocalArtifactStore(dataDir),
  ) {
    // Isolate the adapter's metadata cache and pi's global config surface from
    // any local ~/.pi installation. Set before any extension code runs.
    process.env.PI_CODING_AGENT_DIR = join(dataDir, "pi-agent");
    mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
  }

  /** Sends one user prompt into the conversation's session (creating it lazily)
   * and returns once the prompt is accepted; the turn streams via subscribe(). */
  async prompt(
    conversationId: string,
    text: string,
    images: Array<{ data: string; mimeType: string }> = [],
  ): Promise<void> {
    const agent = await this.ensureAgent(conversationId);
    const imageBlocks = images.map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType }));
    this.recordPrompt(conversationId, [{ type: "text", text }, ...imageBlocks]);
    // followUp queues cleanly when a turn is already streaming and is a no-op
    // difference when idle.
    void agent.session.prompt(text, {
      streamingBehavior: "followUp",
      ...(imageBlocks.length > 0 ? { images: imageBlocks } : {}),
    }).catch((error: unknown) => {
      this.emit(conversationId, {
        type: "agent_error",
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /** Persists the prompt eagerly only when no run is in flight: a mid-run
   * prompt is queued by pi and reaches the store at its true transcript
   * position via agent_end.messages, where an eager row would land before the
   * in-flight run's output. Accepted trade-off: a follow-up queued mid-turn is
   * not visible in the store until the turn ends, consistent with the M1
   * stance that mid-turn reloads drop in-flight events. */
  private recordPrompt(conversationId: string, content: unknown[]): void {
    if (this.status(conversationId).running) return;
    const persisted = this.persist(conversationId, () => appendStoredMessages(this.db, conversationId, [
      { role: "user", content, timestamp: Date.now() },
    ]));
    // A failed eager write must not register a pending entry, or the run's
    // own copy would be consumed at agent_end and the message lost entirely.
    if (!persisted) return;
    const pending = this.pendingEagerUserContent.get(conversationId) ?? [];
    pending.push(JSON.stringify(content));
    this.pendingEagerUserContent.set(conversationId, pending);
  }

  /** Aborts the in-flight turn, if any. A conversation without a live session
   * has nothing to abort. */
  async abort(conversationId: string): Promise<void> {
    const pending = this.agents.get(conversationId);
    if (!pending) return;
    const agent = await pending.catch(() => undefined);
    await agent?.session.abort();
  }

  /** Subscribes to the conversation's live event stream (no replay: persisted
   * history covers earlier turns, and event-level replay is out of scope for
   * M1). Clients must open the stream before POSTing a prompt. */
  subscribe(conversationId: string, listener: (event: AgentServerEvent) => void): () => void {
    const channel = this.channel(conversationId);
    channel.subscribers.add(listener);
    return () => {
      channel.subscribers.delete(listener);
    };
  }

  /** Authoritative run status for the conversation, used to seed every SSE
   * (re)connect so clients never infer idleness from stream silence. */
  status(conversationId: string): AgentRunStatus {
    return this.statuses.get(conversationId)?.snapshot() ?? { running: false };
  }

  async dispose(): Promise<void> {
    const pending = [...this.agents.values()];
    this.agents.clear();
    await Promise.all(pending.map(async (entry) => {
      const agent = await entry.catch(() => undefined);
      agent?.session.dispose();
    }));
  }

  private conversationDir(conversationId: string): string {
    return conversationAgentDir(this.dataDir, conversationId);
  }

  private channel(conversationId: string): Channel {
    let channel = this.channels.get(conversationId);
    if (!channel) {
      channel = { subscribers: new Set() };
      this.channels.set(conversationId, channel);
    }
    return channel;
  }

  private emit(conversationId: string, event: AgentServerEvent): void {
    for (const listener of this.channel(conversationId).subscribers) listener(event);
  }

  private ensureAgent(conversationId: string): Promise<ConversationAgent> {
    let pending = this.agents.get(conversationId);
    if (!pending) {
      pending = this.createAgent(conversationId);
      this.agents.set(conversationId, pending);
      // A failed creation must not poison the conversation forever.
      pending.catch(() => this.agents.delete(conversationId));
    }
    return pending;
  }

  private async resolveModel(): Promise<Model<Api>> {
    const { settings } = readEffectiveSettings(this.db);
    if (!settings.modelJson) {
      throw new Error("No model is configured. Set one in Settings or via CHAMFER_MODEL.");
    }
    const parsed = JSON.parse(settings.modelJson) as Model<Api>;
    // pi-ai does not honor *_BASE_URL environment variables; the base URL must
    // ride on the model object itself (same pattern as the old client loop).
    const { requestModel, apiKey } = resolveProviderConfig(settings, parsed);
    const runtime = await this.runtime();
    const provider = providerOf(parsed);
    if (provider && apiKey) await runtime.setRuntimeApiKey(provider, apiKey);
    return requestModel as Model<Api>;
  }

  /** Re-resolves the configured model and its provider credential from
   * effective settings into the model runtime and every live session.
   *
   * Credentials: pi resolves them per request - every LLM call goes
   * ModelRuntime.stream -> prepareRequest -> getAuth against the credential
   * store - so already-built sessions pick a rotated credential up on their
   * next request.
   *
   * Model identity and base URL, by contrast, are captured at session build
   * (agent.state.model). pi's AgentSession.setModel is the supported switch:
   * it validates auth for the new provider, swaps agent.state.model, and
   * records the change in the session manager - all provider-agnostic - so a
   * settings model change reaches a warm session without a rebuild. The
   * hosted container calls this after each per-turn settings delivery; which
   * provider is involved comes entirely from the configured model. */
  async refreshCredentials(): Promise<void> {
    const model = await this.resolveModel();
    for (const pending of [...this.agents.values()]) {
      const agent = await pending.catch(() => undefined);
      if (!agent) continue;
      const live = agent.session.model;
      if (live && live.provider === model.provider && live.id === model.id && live.baseUrl === model.baseUrl) {
        continue;
      }
      await agent.session.setModel(model);
    }
  }

  private runtime(): Promise<ModelRuntime> {
    // Credentials live in Chamfer settings, not in ~/.pi/agent; an in-memory
    // store keeps the runtime isolated from any local pi installation.
    // Environment API keys (ANTHROPIC_API_KEY et al) still apply as a fallback.
    this.modelRuntime ??= ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
    });
    return this.modelRuntime;
  }

  private directToolNames(session: AgentSession): Set<string> {
    const names = new Set<string>();
    for (const tool of session.agent.state.tools ?? []) names.add(tool.name);
    return names;
  }

  private async createAgent(conversationId: string): Promise<ConversationAgent> {
    const conversation = getConversation(this.db, conversationId);
    if (!conversation) throw new Error("Conversation not found");
    const environment = conversation.cadEnvironment;
    const dir = this.conversationDir(conversationId);
    mkdirSync(dir, { recursive: true });

    const { settings } = readEffectiveSettings(this.db);
    const expectedTools: readonly string[] = environment === "fusion" ? FUSION_DIRECT_TOOLS : BUILD123D_DIRECT_TOOLS;
    if (environment === "fusion") {
      await writeFusionMcpConfig(dir, settings.fusionMcpEndpoint);
    } else {
      writeBuild123dMcpConfig(dir);
    }

    const attemptStart = Date.now();
    const session = await this.buildSession(conversationId, environment, dir);
    // Known adapter behavior: with a fresh (or stale, e.g. a moved Fusion port)
    // metadata cache, the first extension load registers no direct tools; the
    // first session's keep-alive startup connect populates the cache, and one
    // session.reload() (shutdown + factory re-run + session_start) then
    // registers them. Wait for the cache write before reloading.
    const serverName = environment === "fusion" ? "fusion" : "b123";
    if (![...expectedTools].every((name) => this.directToolNames(session).has(name))) {
      await this.waitForAdapterCache(serverName, attemptStart);
      if (environment === "fusion") {
        // The port can move between the first discovery and now.
        await writeFusionMcpConfig(dir);
      }
      await this.inConversationCwd(dir, () => session.reload());
      if (![...expectedTools].every((name) => this.directToolNames(session).has(name))) {
        console.warn(
          `agent session for ${conversationId} is missing direct MCP tools; continuing with whatever is registered`,
        );
      }
    }

    await this.seedArtifactWatermark(conversationId, dir);

    session.subscribe((event) => this.onSessionEvent(conversationId, environment, dir, event));
    return { session, environment, dir };
  }

  /** Records a pre-existing export as already seen, so reopening a
   * conversation does not fire a spurious artifact_updated on the next turn;
   * the store then reports updated only for a genuine rewrite. */
  private async seedArtifactWatermark(conversationId: string, dir: string): Promise<void> {
    const existing = observeExport(dir);
    if (existing) await this.artifactStore.record(conversationId, existing);
  }

  /** Waits until the adapter's metadata cache carries the server's tool list
   * (written by the first session's startup connect), so the rebuilt session's
   * extension load can register direct tools. Returns false on timeout. */
  private async waitForAdapterCache(serverName: string, since: number, timeoutMs = 180_000): Promise<boolean> {
    const cachePath = join(process.env.PI_CODING_AGENT_DIR ?? join(this.dataDir, "pi-agent"), "mcp-cache.json");
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        if (statSync(cachePath).mtimeMs >= since) {
          const parsed = JSON.parse(readFileSync(cachePath, "utf8")) as {
            servers?: Record<string, { tools?: unknown[] }>;
          };
          const entry = parsed.servers?.[serverName];
          if (entry && Array.isArray(entry.tools) && entry.tools.length > 0) return true;
        }
      } catch {
        // Cache not written yet; keep polling.
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return false;
  }

  /** Runs a session build or reload with the process chdir'd into the
   * conversation dir, serialized against other creations: pi-mcp-adapter
   * resolves its direct-tool registration config from process.cwd() when the
   * extension factory runs. */
  private inConversationCwd<T>(dir: string, work: () => Promise<T>): Promise<T> {
    const attempt = this.creationChain.then(async () => {
      const previousCwd = process.cwd();
      process.chdir(dir);
      try {
        return await work();
      } finally {
        process.chdir(previousCwd);
      }
    });
    this.creationChain = attempt.catch(() => undefined);
    return attempt;
  }

  private buildSession(
    conversationId: string,
    environment: CadEnvironment,
    dir: string,
  ): Promise<AgentSession> {
    return this.inConversationCwd(dir, async () => {
      const model = await this.resolveModel();
      // Nothing else is discovered from disk: no skills, prompt templates,
      // themes, or context files - only the short CAD system prompt and the
      // explicitly loaded MCP adapter extension.
      const resourceLoader = new DefaultResourceLoader({
        cwd: dir,
        agentDir: process.env.PI_CODING_AGENT_DIR ?? join(this.dataDir, "pi-agent"),
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        additionalExtensionPaths: [mcpAdapterExtensionPath()],
        systemPrompt: systemPromptFor(environment),
      });
      await resourceLoader.reload();

      // Sessions are in-memory, so a process restart loses pi's own history;
      // pre-populating the manager makes createAgentSession restore the
      // conversation context through its native resume path. The factory lets
      // the seeder discard a manager part-seeded by a bad row for a fresh
      // unseeded one instead of failing session creation.
      const sessionManager = seedSessionFromStore(this.db, conversationId, () => SessionManager.inMemory(dir));
      const { session } = await createAgentSession({
        cwd: dir,
        model,
        modelRuntime: await this.runtime(),
        noTools: "builtin",
        resourceLoader,
        sessionManager,
        settingsManager: SettingsManager.inMemory(),
      });
      // The SDK never fires session_start on its own; binding wakes the
      // extension runtime so the adapter connects its keep-alive servers.
      // An error listener must be bound or reload() skips re-emitting
      // session_start after swapping the extension runtime.
      await session.bindExtensions({
        onError: (error: unknown) => {
          console.error("agent extension error:", error instanceof Error ? error.message : error);
        },
      });
      return session;
    });
  }

  private onSessionEvent(
    conversationId: string,
    environment: CadEnvironment,
    dir: string,
    event: AgentSessionEvent,
  ): void {
    let tracker = this.statuses.get(conversationId);
    if (!tracker) {
      tracker = new AgentStatusTracker();
      this.statuses.set(conversationId, tracker);
    }
    tracker.apply(event);
    this.emit(conversationId, event);
    // agent_end.messages is the run's full transcript (per-run, so retry
    // continuations never re-carry earlier output); persisting it whole keeps
    // the executed CAD code (toolCall arguments) durable across restarts.
    // Pending eager rows clear unconditionally: the run carrying them has
    // ended, so a leftover entry could only mis-consume a later prompt.
    if (event.type === "agent_end") {
      const eager = this.pendingEagerUserContent.get(conversationId) ?? [];
      this.pendingEagerUserContent.delete(conversationId);
      this.persist(conversationId, () => persistTurnTranscript(this.db, conversationId, event.messages, eager));
    }
    // The export contract writes ./artifact.stl inside the conversation cwd;
    // a post-turn stat check is the agreed M1 signal (no file watcher).
    if (environment === "build123d" && (event.type === "turn_end" || event.type === "agent_end")) {
      this.checkArtifact(conversationId, dir);
    }
  }

  private checkArtifact(conversationId: string, dir: string): void {
    const exportFile = observeExport(dir);
    if (!exportFile) return;
    void this.artifactStore.record(conversationId, exportFile).then((record) => {
      if (record.updated) this.emit(conversationId, { type: "artifact_updated", revision: record.revision });
    }).catch((error: unknown) => {
      // A failed record must not kill the run; the export is still in the
      // conversation cwd and the next turn end records again.
      console.error(
        `failed to record artifact for ${conversationId}:`,
        error instanceof Error ? error.message : error,
      );
    });
  }

  private persist(conversationId: string, write: () => void): boolean {
    try {
      write();
      return true;
    } catch (error) {
      // Never emit agent_error here: the run is still alive, and clients
      // treat agent_error as run-fatal (it flips the turn status to idle).
      console.error(
        `failed to persist message for ${conversationId}:`,
        error instanceof Error ? error.message : error,
      );
      return false;
    }
  }
}
