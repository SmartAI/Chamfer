import type { DatabaseSync } from "node:sqlite";
import { createParser } from "eventsource-parser";
import {
  isLlmProvider,
  modelJsonProvider,
  resolveTurnFunding,
  type MessageDto,
  type Provider,
  type SettingsDto,
} from "@chamfer/shared";
import { createMessage, getConversation, listMessages, maxMessageSeq } from "../../server/src/conversationStore";
import { readEffectiveSettings } from "../../server/src/settingsStore";
import {
  AgentStatusTracker,
  type AgentRunStatus,
  type AgentServerEvent,
} from "../../server/src/agent/agentStatus";
import type { AgentSessionHost } from "../../server/src/routes/agent";
import type { ArtifactStore } from "../../server/src/agent/artifactStore";

/** Hosted agent turns (issue #51, ADR 0003 increment 3b): the user Durable
 * Object drives one turn at a time on the user's container and is the only
 * store of record. Per turn: seed the full stored transcript (watermark-
 * idempotent on the container side), mint a fresh conversation-scoped proxy
 * token, deliver both, forward the prompt, then watch the container's event
 * stream and - independent of any browser connection - drain the turn's new
 * transcript rows and the artifact bytes out of the container when the run
 * ends. A DO alarm backs the watcher up across evictions, so a closed tab
 * never loses a transcript.
 */

/** Seconds budgeted per CAD-run cycle in a worst-case turn: one streamed LLM
 * round (tens of seconds on a long transcript) plus one build123d/OCCT
 * execution (worst observed around two minutes of solid geometry on the
 * container's half vCPU). */
const SECONDS_PER_CAD_RUN_CYCLE = 180;

/** The product default for CHAMFER_MAX_CAD_RUNS (.env.example: the agent
 * aborts a turn after that many CAD executions). */
export const DEFAULT_MAX_CAD_RUNS = 10;

/** Per-turn token TTL, sized to a worst-case turn: the CAD-run cap times the
 * per-cycle budget - 10 x 3 min = 30 min at the default cap. Takes the raw
 * CHAMFER_MAX_CAD_RUNS value so a deployment that raises the cap does not
 * silently outrun its tokens (same positive-integer validation as
 * envConfig). The proxy rejects the token after expiry, so a runaway turn
 * loses its LLM egress at the choke point instead of spending forever. */
export function turnTokenTtlSeconds(rawMaxCadRuns?: string): number {
  const maxCadRuns = rawMaxCadRuns && /^[1-9][0-9]*$/.test(rawMaxCadRuns)
    ? Number(rawMaxCadRuns)
    : DEFAULT_MAX_CAD_RUNS;
  return maxCadRuns * SECONDS_PER_CAD_RUN_CYCLE;
}

/** Alarm cadence while a turn is live. Well inside the container's 5 min
 * sleepAfter, so the drain safety net always fires before the container - and
 * the turn's only copy of the transcript - can scale to zero. */
export const TURN_ALARM_INTERVAL_MS = 30_000;

/** Hard wall for one turn: token TTL plus grace for a final CAD execution
 * that outlives its token. Past this the alarm force-drains whatever the
 * container has rather than polling a hung run forever. */
export function turnDeadlineMs(ttlSeconds: number): number {
  return ttlSeconds * 1000 + 5 * 60_000;
}

export interface TurnMarker {
  conversationId: string;
  startedAtMs: number;
}

/** One turn's resolved model: what the seed delivers to the container. */
export interface TurnLlmSelection {
  modelJson: string;
  provider: Provider;
}

/** Turn-start model selection (issue #53): maps the shared funding rule
 * (resolveTurnFunding in @chamfer/shared - the same one behind the client's
 * composer gate and the title-generation fallback) onto a concrete delivery.
 * The fallback model's provider is parsed from the fallback model itself,
 * never assumed. A blocked verdict still delivers the user's model so the
 * proxy's refusal (naming the missing provider key) lands on the transcript
 * instead of vanishing; only a turn with no model at all, or an unroutable
 * provider and no fallback, fails here. */
export function selectTurnModel(
  settings: SettingsDto,
  demoModelJson: string | undefined,
): TurnLlmSelection {
  const fallbackProvider = modelJsonProvider(demoModelJson);
  if (demoModelJson !== undefined && !isLlmProvider(fallbackProvider)) {
    throw new Error(`the deployment's demo model names unroutable provider ${String(fallbackProvider)}`);
  }
  const selectedProvider = modelJsonProvider(settings.modelJson);
  const verdict = resolveTurnFunding({
    selectedProvider,
    keys: settings,
    fallbackProvider: isLlmProvider(fallbackProvider) ? fallbackProvider : undefined,
  });
  switch (verdict.kind) {
    case "run":
      if (verdict.model === "fallback") {
        return { modelJson: demoModelJson!, provider: fallbackProvider as Provider };
      }
      return { modelJson: settings.modelJson!, provider: selectedProvider as Provider };
    case "blocked":
      return { modelJson: settings.modelJson!, provider: verdict.missingProvider };
    case "unroutable":
      throw new Error(
        `Model provider ${verdict.provider} is not supported for hosted turns; pick an Anthropic, OpenAI, or Google model in Settings.`,
      );
    case "no-model":
      throw new Error("No model is configured. Pick one in Settings.");
  }
}

/** Durable half of the turn state: the marker and the alarm both survive DO
 * eviction (workerd persists alarms), which is what makes the drain
 * independent of any browser connection. */
export interface TurnStateStore {
  get(): Promise<TurnMarker | undefined>;
  put(marker: TurnMarker): Promise<void>;
  clear(): Promise<void>;
  scheduleAlarm(atMs: number): Promise<void>;
  cancelAlarm(): Promise<void>;
}

export interface SseFrame {
  event?: string;
  data?: string;
}

/** Incremental SSE framing over eventsource-parser (the same spec-complete
 * parser the MCP SDK streams through). Kept as a tiny pull adapter because
 * the watch loop wants complete frames per read, not callbacks: feed decoded
 * chunks in, finished frames come out in order. */
export class SseFrameParser {
  private readonly frames: SseFrame[] = [];
  private readonly parser = createParser({
    onEvent: (message) => {
      this.frames.push({
        ...(message.event !== undefined ? { event: message.event } : {}),
        data: message.data,
      });
    },
  });

  push(chunk: string): SseFrame[] {
    this.parser.feed(chunk);
    return this.frames.splice(0);
  }
}

export interface ContainerTurnHostDeps {
  /** The DO's conversation store - the store of record the drain lands in. */
  db: DatabaseSync;
  /** Fetch into this user's container; Container.fetch wakes it when asleep. */
  containerFetch(path: string, init?: RequestInit): Promise<Response>;
  /** Fresh conversation-scoped proxy token for one turn; the caller mints it
   * with the same turnTtlSeconds this host sizes its deadline from. */
  mintTurnToken(conversationId: string): Promise<string>;
  /** This conversation's per-provider proxy base URL as reachable from inside
   * the container. */
  proxyBaseUrl(provider: Provider, conversationId: string): string;
  /** Serialized demo default model (the deployment's pinned anthropic model)
   * when a demo key can fund keyless turns; absent otherwise. */
  demoModelJson?: string;
  /** R2-backed artifact store the drain copies the export into. */
  artifacts: ArtifactStore;
  turnState: TurnStateStore;
  /** The minted tokens' TTL; defaults to the worst-case turn at the default
   * CAD-run cap (turnTokenTtlSeconds). */
  turnTtlSeconds?: number;
  now?: () => number;
  log?: (message: string) => void;
}

function jsonInit(body: unknown): RequestInit {
  return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

async function errorBodyOf(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error) return body.error;
  } catch {
    // Fall through to the status line.
  }
  return `HTTP ${response.status}`;
}

function statusOfEvent(event: Record<string, unknown>): AgentRunStatus {
  return {
    running: event.running === true,
    ...(typeof event.startedAt === "number" ? { startedAt: event.startedAt } : {}),
    ...(typeof event.activeTool === "object" && event.activeTool !== null
      ? { activeTool: event.activeTool as AgentRunStatus["activeTool"] }
      : {}),
  };
}

/** The user DO's AgentSessionHost over the per-user container. The standard
 * agent routes mount against it unchanged, so the browser-facing surface is
 * byte-compatible with the local server's: prompts 202, events relay the
 * container's pi stream frame by frame (unbuffered - each frame is forwarded
 * the moment it parses), abort proxies through.
 *
 * Turns serialize per container: the container's settings table is global
 * while the delivered proxy URL and token are conversation-scoped, so a
 * prompt for a second conversation while a turn runs is refused; a follow-up
 * prompt for the live conversation forwards through (pi queues it, exactly
 * the local behavior) with a freshly minted token to extend the runway. */
export class ContainerTurnHost implements AgentSessionHost {
  private readonly channels = new Map<string, Set<(event: AgentServerEvent) => void>>();
  private readonly statuses = new Map<string, AgentRunStatus>();
  private activeTurn: { conversationId: string; tracker: AgentStatusTracker } | undefined;
  private watcher: Promise<void> | undefined;
  /** The live watcher's stream reader, kept so a prompt that fails after the
   * relay is armed (abandonTurn) can cancel it instead of leaking an SSE read
   * against an idle container. */
  private watcherReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  /** Serializes every write path against the container and R2: prompt starts,
   * turn completions (drain), and mid-turn artifact pulls. The invariant:
   * artifacts.record is head-then-put with no conditional write, so two
   * concurrent recorders (the live watcher's artifact_updated pull vs an
   * alarm-driven force-drain) could double-advance the revision with
   * different bytes - every artifact write for this container therefore goes
   * through this chain. */
  private chain: Promise<unknown> = Promise.resolve();
  private readonly deadlineMs: number;

  constructor(private readonly deps: ContainerTurnHostDeps) {
    this.deadlineMs = turnDeadlineMs(deps.turnTtlSeconds ?? turnTokenTtlSeconds());
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private log(message: string): void {
    (this.deps.log ?? console.error)(message);
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const attempt = this.chain.then(work);
    this.chain = attempt.catch(() => undefined);
    return attempt;
  }

  async prompt(
    conversationId: string,
    text: string,
    images: Array<{ data: string; mimeType: string }> = [],
  ): Promise<void> {
    return this.enqueue(async () => {
      // The #40 rule: Fusion is local-only, permanently. The container guard
      // is not enough - it would only reject after the conversation was
      // seeded as build123d, silently running Fusion prompts against the
      // wrong environment - so the stored environment is checked here first.
      const conversation = getConversation(this.deps.db, conversationId);
      if (!conversation) throw new Error("Conversation not found");
      if (conversation.cadEnvironment !== "build123d") {
        throw new Error(
          "Only build123d conversations run on the hosted deployment; Fusion is local-only (npx chamfer).",
        );
      }
      if (this.activeTurn && this.activeTurn.conversationId !== conversationId) {
        throw new Error(
          "Another conversation's turn is still running. Hosted turns run one at a time; wait for it to finish.",
        );
      }
      // Turn-start model selection (issue #53): the user's Settings model when
      // its provider is funded, else the demo default - resolved fresh every
      // prompt so a Settings change lands on the very next turn. The container
      // rebuilds or switches its live session when the delivered model differs.
      const llm = selectTurnModel(readEffectiveSettings(this.deps.db).settings, this.deps.demoModelJson);
      // Fresh token every prompt - also on a mid-turn follow-up, where the
      // delivery extends the live run's auth runway (the container applies it
      // to its settings and live runtime; pi resolves credentials per request).
      const token = await this.deps.mintTurnToken(conversationId);
      const rows = listMessages(this.deps.db, conversationId).map(({ id, seq, role, contentJson }) => ({
        id,
        seq,
        role,
        contentJson,
      }));
      const seedResponse = await this.deps.containerFetch(
        `/api/container/${conversationId}/seed`,
        jsonInit({
          cadEnvironment: "build123d",
          rows,
          llm: {
            modelJson: llm.modelJson,
            provider: llm.provider,
            baseUrl: this.deps.proxyBaseUrl(llm.provider, conversationId),
            token,
          },
        }),
      );
      if (!seedResponse.ok) {
        throw new Error(`container seed failed: ${await errorBodyOf(seedResponse)}`);
      }
      // Arm the relay BEFORE the prompt starts the turn, so no early event is
      // dropped. The container's agent_start (and the first streamed message on
      // a fast turn) fire the instant the prompt POST lands; if we opened the
      // watcher only afterwards, those events would already be gone (the
      // container's emitter has no replay). Opening /events while the container
      // is still idle means it has subscribed this watcher - it does so right
      // after writing its connect snapshot, which we wait for here - well
      // before the later POST triggers the run. A follow-up prompt mid-turn
      // (activeTurn already set) rides the existing watcher, exactly as before.
      const firstTurn = !this.activeTurn;
      if (firstTurn) {
        this.activeTurn = { conversationId, tracker: new AgentStatusTracker() };
        await this.startWatcher(conversationId, { finishOnIdle: false });
      }
      const promptResponse = await this.deps.containerFetch(
        `/api/agent/${conversationId}/messages`,
        jsonInit(images.length > 0 ? { text, images } : { text }),
      );
      if (promptResponse.status !== 202) {
        // The turn never started; tear the armed relay back down so an idle
        // container is not watched forever and no half-started turn lingers.
        if (firstTurn) await this.abandonTurn(conversationId);
        throw new Error(await errorBodyOf(promptResponse));
      }
      if (firstTurn) await this.commitTurn(conversationId);
    });
  }

  async abort(conversationId: string): Promise<void> {
    // Nothing to abort without a live turn; do not wake a sleeping container.
    if (this.activeTurn?.conversationId !== conversationId) return;
    await this.deps.containerFetch(`/api/agent/${conversationId}/abort`, { method: "POST" });
  }

  subscribe(conversationId: string, listener: (event: AgentServerEvent) => void): () => void {
    let channel = this.channels.get(conversationId);
    if (!channel) {
      channel = new Set();
      this.channels.set(conversationId, channel);
    }
    channel.add(listener);
    return () => {
      channel.delete(listener);
    };
  }

  status(conversationId: string): AgentRunStatus {
    const known = this.statuses.get(conversationId);
    if (known) return known;
    return { running: this.activeTurn?.conversationId === conversationId };
  }

  /** Rehydrates a turn that outlived this DO instance (eviction, redeploy):
   * the persisted marker says a run may still be live, so watching resumes
   * and the completion drain still happens. Called before the first request. */
  async restore(): Promise<void> {
    const marker = await this.deps.turnState.get();
    if (!marker) return;
    this.activeTurn = { conversationId: marker.conversationId, tracker: new AgentStatusTracker() };
    this.statuses.set(marker.conversationId, { running: true, startedAt: marker.startedAtMs });
    await this.deps.turnState.scheduleAlarm(this.now() + TURN_ALARM_INTERVAL_MS);
    this.startWatcher(marker.conversationId, { finishOnIdle: true });
  }

  /** The DO alarm handler body: the drain path that needs no browser and no
   * surviving watcher. Polls the container's run state; re-arms while the run
   * is live (each poll also renews the container's sleep timer), completes
   * the turn once it is not - or once the turn passes its hard deadline. */
  async onAlarm(): Promise<void> {
    const marker = await this.deps.turnState.get();
    if (!marker) return;
    const { conversationId } = marker;
    this.activeTurn ??= { conversationId, tracker: new AgentStatusTracker() };
    const age = this.now() - marker.startedAtMs;
    if (age < this.deadlineMs) {
      const remote = await this.remoteStatus(conversationId);
      if (remote === undefined) {
        // Container unreachable this tick; retry rather than declare the turn over.
        await this.deps.turnState.scheduleAlarm(this.now() + TURN_ALARM_INTERVAL_MS);
        return;
      }
      if (remote.running) {
        await this.deps.turnState.scheduleAlarm(this.now() + TURN_ALARM_INTERVAL_MS);
        if (!this.watcher) this.startWatcher(conversationId, { finishOnIdle: true });
        return;
      }
    } else {
      this.log(`turn for ${conversationId} passed its deadline; force-draining`);
    }
    await this.completeTurn(conversationId, { recheck: false });
  }

  /** Commits a freshly-armed turn once the prompt has been accepted: mark it
   * running, tell already-connected browsers the turn is live NOW (the mirror
   * of the running:false snapshot completeTurn emits at the end, so the client
   * fold flips streaming on it), and persist the durable marker + alarm that
   * make the drain survive eviction. The watcher was already started by the
   * arm step in prompt(), so this only records that the run is underway. */
  private async commitTurn(conversationId: string): Promise<void> {
    const startedAt = this.now();
    this.statuses.set(conversationId, { running: true, startedAt });
    this.emit(conversationId, { type: "agent_status", running: true, startedAt });
    await this.deps.turnState.put({ conversationId, startedAtMs: startedAt });
    await this.deps.turnState.scheduleAlarm(startedAt + TURN_ALARM_INTERVAL_MS);
  }

  /** Tears an armed-but-uncommitted turn back down: the prompt was rejected, so
   * the watcher is reading an idle container that will never emit. Cancel it
   * and drop the active turn. No marker or alarm was persisted yet (commitTurn
   * runs only after a 202) and no running snapshot was emitted, so there is
   * nothing else to undo. */
  private async abandonTurn(conversationId: string): Promise<void> {
    if (this.activeTurn?.conversationId === conversationId) this.activeTurn = undefined;
    const watcher = this.watcher;
    await this.watcherReader?.cancel().catch(() => {});
    await watcher?.catch(() => {});
  }

  /** Starts the relay watcher and resolves once its subscription to the
   * container's event stream is provably live - the container writes its
   * connect snapshot right after it subscribes, so receiving that snapshot
   * (onReady below) means every subsequent event will reach us. prompt() awaits
   * this before it POSTs, so the turn's agent_start is never missed. Callers
   * that do not need the barrier (restore, the alarm net) may ignore the
   * returned promise. */
  private startWatcher(conversationId: string, options: { finishOnIdle: boolean }): Promise<void> {
    if (this.watcher) return Promise.resolve();
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    this.watcher = this.watch(conversationId, options, resolveReady)
      .catch((error: unknown) => {
        // The alarm safety net owns recovery from a dead watcher.
        this.log(`turn watcher for ${conversationId} failed: ${error instanceof Error ? error.message : String(error)}`);
        return "ended" as const;
      })
      .then(async (outcome) => {
        this.watcher = undefined;
        // Unblock any arm barrier waiting on a snapshot that will never come now
        // (the stream died before its first frame); prompt() then POSTs anyway
        // and the alarm net owns recovery, exactly as a mid-turn watcher death.
        resolveReady();
        if (outcome === "complete") await this.completeTurn(conversationId, { recheck: true });
      });
    return ready;
  }

  /** Consumes the container's SSE stream, forwarding each parsed event to the
   * browser subscribers immediately, until a completion signal. Returns
   * "complete" when the run finished (agent_settled - pi's once-per-prompt
   * settlement event, which unlike agent_end is not followed by retry or
   * overflow-compaction continuations - or a run-fatal agent_error), "ended"
   * when the stream died first - in which case the alarm net finishes the
   * turn. */
  private async watch(
    conversationId: string,
    options: { finishOnIdle: boolean },
    onReady: () => void,
  ): Promise<"complete" | "ended"> {
    const response = await this.deps.containerFetch(`/api/agent/${conversationId}/events`);
    if (!response.ok || !response.body) {
      throw new Error(`container events stream failed: HTTP ${response.status}`);
    }
    const reader = response.body.getReader();
    this.watcherReader = reader;
    const decoder = new TextDecoder();
    const parser = new SseFrameParser();
    let sawStatusSnapshot = false;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return "ended";
        for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
          if (frame.event === "keepalive" || frame.data === undefined) continue;
          let event: AgentServerEvent;
          try {
            event = JSON.parse(frame.data) as AgentServerEvent;
          } catch {
            continue;
          }
          if (typeof (event as { type?: unknown }).type !== "string") continue;
          if (event.type === "agent_status") {
            // Connect-time snapshot: fold into our own status, never forward -
            // browsers get snapshots from their own (re)connects, like locally.
            this.statuses.set(conversationId, statusOfEvent(event as unknown as Record<string, unknown>));
            // A restored watcher finding the run already over means the
            // completion signal fired while no watcher was alive: drain now.
            if (options.finishOnIdle && !sawStatusSnapshot && !(event as { running?: unknown }).running) {
              return "complete";
            }
            // The first snapshot is the readiness barrier: the subscription is
            // now live, so prompt()'s arm step may release and POST the prompt.
            if (!sawStatusSnapshot) onReady();
            sawStatusSnapshot = true;
            continue;
          }
          if (await this.handleTurnEvent(conversationId, event) === "complete") return "complete";
        }
      }
    } finally {
      if (this.watcherReader === reader) this.watcherReader = undefined;
      reader.cancel().catch(() => {});
    }
  }

  private async handleTurnEvent(conversationId: string, event: AgentServerEvent): Promise<"continue" | "complete"> {
    if (event.type === "artifact_updated") {
      // Copy the rewrite into R2 before telling browsers, so the artifact
      // route (which serves from R2) already has it when the viewer refetches.
      // Enqueued: see the chain invariant - an alarm-driven drain must never
      // interleave with this pull's head-then-put record.
      try {
        await this.enqueue(() => this.pullArtifact(conversationId, event.revision));
      } catch (error) {
        // The turn-end drain retries; a mid-turn copy failure is not fatal.
        this.log(`mid-turn artifact pull failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      return "continue";
    }
    const tracker = this.activeTurn?.conversationId === conversationId ? this.activeTurn.tracker : undefined;
    if (tracker) {
      tracker.apply(event);
      this.statuses.set(conversationId, tracker.snapshot());
    }
    this.emit(conversationId, event);
    if (event.type === "agent_error") return "complete";
    // agent_end is NOT completion: the session may continue the same turn
    // (retry, overflow compact-and-retry). Completing here would drain
    // mid-turn, cancel the alarm, and orphan the rest of the run - browsers
    // would sit on "Done" while the container keeps working.
    if (event.type === "agent_settled") return "complete";
    return "continue";
  }

  /** Ends the turn: drain, then release the marker and alarm. With recheck, a
   * follow-up prompt that was accepted while the drain ran keeps the turn
   * alive (new marker, new watcher) instead of being orphaned. On a drain
   * failure the marker and alarm stay, so the alarm retries; the container's
   * copy is only unreachable, not consumed. */
  private async completeTurn(conversationId: string, options: { recheck: boolean }): Promise<void> {
    await this.enqueue(async () => {
      if (this.activeTurn?.conversationId !== conversationId) return;
      try {
        await this.drain(conversationId);
      } catch (error) {
        this.log(`turn drain for ${conversationId} failed; alarm will retry: ${error instanceof Error ? error.message : String(error)}`);
        await this.deps.turnState.scheduleAlarm(this.now() + TURN_ALARM_INTERVAL_MS);
        return;
      }
      if (options.recheck) {
        const remote = await this.remoteStatus(conversationId);
        if (remote?.running) {
          await this.deps.turnState.put({ conversationId, startedAtMs: this.now() });
          await this.deps.turnState.scheduleAlarm(this.now() + TURN_ALARM_INTERVAL_MS);
          this.startWatcher(conversationId, { finishOnIdle: true });
          return;
        }
      }
      this.activeTurn = undefined;
      await this.deps.turnState.clear();
      await this.deps.turnState.cancelAlarm();
      this.statuses.set(conversationId, { running: false });
      this.emit(conversationId, { type: "agent_status", running: false });
    });
  }

  /** Pulls everything of record out of the container: transcript rows above
   * the DO store's watermark verbatim (ids and seqs preserved), then the
   * artifact bytes when the container reports a revision. A 404 means a fresh
   * container that never held this conversation - nothing left to drain. */
  private async drain(conversationId: string): Promise<void> {
    const afterSeq = maxMessageSeq(this.deps.db, conversationId);
    const response = await this.deps.containerFetch(
      `/api/container/${conversationId}/transcript?afterSeq=${afterSeq}`,
    );
    if (response.status === 404) {
      this.log(`container has no transcript for ${conversationId} (fresh boot); nothing to drain`);
      return;
    }
    if (!response.ok) throw new Error(`transcript drain failed: HTTP ${response.status}`);
    const body = (await response.json()) as { rows: MessageDto[]; artifactRevision: number | null };
    for (const row of body.rows) {
      createMessage(this.deps.db, conversationId, {
        id: row.id,
        seq: row.seq,
        role: row.role,
        contentJson: row.contentJson,
      });
    }
    if (body.artifactRevision !== null) {
      await this.pullArtifact(conversationId, body.artifactRevision);
    }
  }

  /** Records the container's export into R2. The container-side revision is
   * its floor(mtime) rewrite signal, which is exactly what the R2 store keys
   * its no-op detection on, so an unchanged artifact costs one HEAD and no
   * byte transfer. Emits artifact_updated with the R2 revision (the one the
   * artifact route serves) only on a genuine rewrite. */
  private async pullArtifact(conversationId: string, containerRevision: number): Promise<void> {
    const record = await this.deps.artifacts.record(conversationId, {
      mtimeMs: containerRevision,
      bytes: async () => {
        const response = await this.deps.containerFetch(`/api/agent/${conversationId}/artifact`);
        if (!response.ok) throw new Error(`artifact fetch failed: HTTP ${response.status}`);
        return new Uint8Array(await response.arrayBuffer());
      },
    });
    if (record.updated) {
      this.emit(conversationId, { type: "artifact_updated", revision: record.revision });
    }
  }

  private async remoteStatus(conversationId: string): Promise<AgentRunStatus | undefined> {
    try {
      const response = await this.deps.containerFetch(`/api/container/${conversationId}/status`);
      if (!response.ok) return undefined;
      return (await response.json()) as AgentRunStatus;
    } catch {
      return undefined;
    }
  }

  private emit(conversationId: string, event: AgentServerEvent): void {
    for (const listener of this.channels.get(conversationId) ?? []) listener(event);
  }
}
