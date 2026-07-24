import { beforeAll, describe, expect, it, vi } from "vitest";
import { openDb } from "../../server/src/db";
import { createConversation, listMessages } from "../../server/src/conversationStore";
import { writeSettings } from "../../server/src/settingsStore";
import { appendStoredMessages } from "../../server/src/agent/turnPersistence";
import type { AgentServerEvent } from "../../server/src/agent/agentStatus";
import type { ArtifactStore } from "../../server/src/agent/artifactStore";
import { mintLlmToken, verifyLlmToken } from "./llmToken";
import { AGENT_CONTAINER_SLEEP_AFTER } from "./agentContainer";
import {
  ContainerTurnHost,
  DEFAULT_MAX_CAD_RUNS,
  selectTurnModel,
  SseFrameParser,
  TURN_ALARM_INTERVAL_MS,
  turnDeadlineMs,
  turnTokenTtlSeconds,
  type TurnMarker,
  type TurnStateStore,
} from "./agentTurns";

// Turn-start model selection reads effective settings, whose env baseline
// would otherwise let the developer shell's keys and CHAMFER_MODEL leak in.
beforeAll(() => {
  for (const name of [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GOOGLE_API_KEY",
    "GEMINI_API_KEY",
    "CHAMFER_MODEL",
    "CHAMFER_PROVIDER",
    "CHAMFER_FAKE_LLM",
  ]) {
    vi.stubEnv(name, "");
  }
});

const DEMO_MODEL_JSON = JSON.stringify({ provider: "anthropic", id: "claude-demo", name: "Claude Demo" });
const GEMINI_MODEL_JSON = JSON.stringify({ provider: "google", id: "gemini-test", name: "Gemini Test" });

/** setup() builds hosts without an explicit TTL, so tests measure against the
 * same defaults the host falls back to. */
const DEFAULT_TTL_SECONDS = turnTokenTtlSeconds();
const DEFAULT_DEADLINE_MS = turnDeadlineMs(DEFAULT_TTL_SECONDS);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

interface FakeRow {
  id: string;
  seq: number;
  role: string;
  contentJson: string;
}

function ssePush() {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    stream,
    frame(event: unknown) {
      controller.enqueue(encoder.encode(`id: 0\ndata: ${JSON.stringify(event)}\n\n`));
    },
    raw(text: string) {
      controller.enqueue(encoder.encode(text));
    },
    close() {
      try {
        controller.close();
      } catch {
        // Already closed or cancelled.
      }
    },
  };
}

/** Scripted stand-in for the container's HTTP surface, consistent across the
 * seed/transcript watermark protocol like the real scratch store is. */
class FakeContainer {
  rows: FakeRow[] = [];
  artifact: { revision: number; bytes: Uint8Array } | undefined;
  status: { running: boolean } = { running: false };
  transcript404 = false;
  seedBodies: Array<{
    rows?: FakeRow[];
    llm?: { baseUrl: string; token: string; modelJson: string; provider: string };
  }> = [];
  promptBodies: Array<{ text: string }> = [];
  abortCount = 0;
  eventsRequests = 0;
  /** Ordered log of the endpoint each fetch hit (path suffix), so tests can
   * assert the relay is armed (/events) before the prompt is POSTed (/messages). */
  callLog: string[] = [];
  sse = ssePush();

  private maxSeq(): number {
    return this.rows.reduce((maximum, row) => Math.max(maximum, row.seq), -1);
  }

  fetch = async (path: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(`https://container${path}`);
    this.callLog.push(url.pathname.split("/").pop() ?? url.pathname);
    if (url.pathname.endsWith("/seed")) {
      const body = JSON.parse(String(init?.body)) as {
        rows?: FakeRow[];
        llm?: { baseUrl: string; token: string; modelJson: string; provider: string };
      };
      this.seedBodies.push(body);
      const watermark = this.maxSeq();
      const appended = (body.rows ?? []).filter((row) => row.seq > watermark);
      this.rows.push(...appended);
      return json({ ok: true, appended: appended.length, maxSeq: this.maxSeq() });
    }
    if (url.pathname.endsWith("/messages")) {
      this.promptBodies.push(JSON.parse(String(init?.body)) as { text: string });
      return json({ ok: true }, 202);
    }
    if (url.pathname.endsWith("/abort")) {
      this.abortCount += 1;
      return json({ ok: true });
    }
    if (url.pathname.endsWith("/events")) {
      this.eventsRequests += 1;
      // Mirror the real container route: the connect-time status snapshot is
      // the first frame. The DO's watcher treats it as its readiness barrier
      // (prompt() waits for it before POSTing), and the run's running state at
      // connect is whatever /status reports.
      this.sse.frame({ type: "agent_status", running: this.status.running });
      return new Response(this.sse.stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    if (url.pathname.endsWith("/transcript")) {
      if (this.transcript404) return json({ error: "not found" }, 404);
      const afterSeq = Number(url.searchParams.get("afterSeq"));
      return json({
        rows: this.rows.filter((row) => row.seq > afterSeq),
        artifactRevision: this.artifact?.revision ?? null,
      });
    }
    if (url.pathname.endsWith("/status")) {
      return json(this.status);
    }
    if (url.pathname.endsWith("/artifact")) {
      if (!this.artifact) return json({ error: "no artifact" }, 404);
      return new Response(this.artifact.bytes, {
        status: 200,
        headers: { "x-artifact-revision": String(this.artifact.revision) },
      });
    }
    throw new Error(`unexpected container path: ${path}`);
  };
}

function memoryTurnState() {
  const state: { marker: TurnMarker | undefined; alarmAt: number | undefined } = {
    marker: undefined,
    alarmAt: undefined,
  };
  let putCount = 0;
  const store: TurnStateStore = {
    get: async () => state.marker,
    put: async (marker) => {
      state.marker = marker;
      putCount += 1;
    },
    clear: async () => {
      state.marker = undefined;
    },
    scheduleAlarm: async (atMs) => {
      state.alarmAt = atMs;
    },
    cancelAlarm: async () => {
      state.alarmAt = undefined;
    },
  };
  return { store, state, putCount: () => putCount };
}

function recordingArtifacts() {
  const written: Array<{ conversationId: string; mtimeMs: number; bytes: Uint8Array }> = [];
  let revision = 0;
  let lastMtime: number | undefined;
  const store: ArtifactStore = {
    record: async (conversationId, exportFile) => {
      if (exportFile.mtimeMs === lastMtime) return { revision, updated: false };
      const bytes = await exportFile.bytes();
      lastMtime = exportFile.mtimeMs;
      revision += 1;
      written.push({ conversationId, mtimeMs: exportFile.mtimeMs, bytes });
      return { revision, updated: true };
    },
    current: async () => undefined,
  };
  return { store, written };
}

function setup(options: { seedMessages?: number } = {}) {
  const db = openDb(":memory:");
  const conversation = createConversation(db, "hosted test");
  const seeded = options.seedMessages ?? 0;
  for (let i = 0; i < seeded; i += 1) {
    appendStoredMessages(db, conversation.id, [
      { role: i % 2 === 0 ? "user" : "assistant", content: [{ type: "text", text: `m${i}` }], timestamp: 1000 + i },
    ]);
  }
  const container = new FakeContainer();
  const turnState = memoryTurnState();
  const artifacts = recordingArtifacts();
  let minted = 0;
  const host = new ContainerTurnHost({
    db,
    // Late-bound so tests can swap container.fetch after setup.
    containerFetch: (path, init) => container.fetch(path, init),
    mintTurnToken: async (conversationId) => `token-${conversationId}-${(minted += 1)}`,
    proxyBaseUrl: (provider, conversationId) => `https://proxy.example/api/llm/${provider}/${conversationId}`,
    artifacts: artifacts.store,
    turnState: turnState.store,
    demoModelJson: DEMO_MODEL_JSON,
    log: () => {},
  });
  const events: AgentServerEvent[] = [];
  host.subscribe(conversation.id, (event) => events.push(event));
  return { db, conversationId: conversation.id, container, turnState, artifacts, host, events };
}

describe("SseFrameParser", () => {
  it("parses frames split across arbitrary chunk boundaries", () => {
    const parser = new SseFrameParser();
    expect(parser.push("id: 1\nda")).toEqual([]);
    expect(parser.push('ta: {"type":"agent_start"}\n\nevent: keepalive\ndata: {}\n')).toEqual([
      { data: '{"type":"agent_start"}' },
    ]);
    expect(parser.push("\n")).toEqual([{ event: "keepalive", data: "{}" }]);
  });

  it("joins multi-line data and keeps event names", () => {
    const parser = new SseFrameParser();
    expect(parser.push("event: x\ndata: a\ndata: b\n\n")).toEqual([{ event: "x", data: "a\nb" }]);
  });
});

describe("turn constants", () => {
  it("mints per-turn tokens with conversation-scoped claims and the turn TTL", async () => {
    const now = Date.now();
    const token = await mintLlmToken(
      "test-secret",
      { userId: "user-1", conversationId: "conv-1", ttlSeconds: DEFAULT_TTL_SECONDS },
      now,
    );
    const claims = await verifyLlmToken("test-secret", token, now);
    expect(claims).toMatchObject({ userId: "user-1", conversationId: "conv-1" });
    expect(claims!.expiresAt).toBe(Math.floor(now / 1000) + DEFAULT_TTL_SECONDS);
    // 10 CAD runs (the CHAMFER_MAX_CAD_RUNS default) at ~3 min per cycle.
    expect(DEFAULT_TTL_SECONDS).toBe(30 * 60);
  });

  it("derives the TTL from a deployment's CHAMFER_MAX_CAD_RUNS", () => {
    expect(turnTokenTtlSeconds("25")).toBe(25 * 180);
    expect(turnTokenTtlSeconds("1")).toBe(180);
    // Anything the cap parser would reject falls back to the product default.
    for (const raw of [undefined, "", "abc", "0", "-3", "2.5"]) {
      expect(turnTokenTtlSeconds(raw)).toBe(DEFAULT_MAX_CAD_RUNS * 180);
    }
  });

  it("keeps the alarm cadence well inside the container's sleep timeout", () => {
    expect(AGENT_CONTAINER_SLEEP_AFTER).toBe("5m");
    expect(TURN_ALARM_INTERVAL_MS).toBeLessThan(5 * 60_000 / 2);
    expect(DEFAULT_DEADLINE_MS).toBeGreaterThan(DEFAULT_TTL_SECONDS * 1000);
  });
});

// Issue #53: which model a hosted turn runs, mirroring the chat path - the
// Settings model when its provider is keyed, else the demo pin, and only as a
// last resort the unfunded Settings model (the proxy's refusal then lands on
// the transcript instead of vanishing).
describe("selectTurnModel", () => {
  it("runs the Settings model when its provider has a key", () => {
    const selection = selectTurnModel(
      { modelJson: GEMINI_MODEL_JSON, googleApiKey: "g-key" },
      DEMO_MODEL_JSON,
    );
    expect(selection).toEqual({ modelJson: GEMINI_MODEL_JSON, provider: "google" });
  });

  it("another provider's key does not fund the selected model", () => {
    const selection = selectTurnModel(
      { modelJson: GEMINI_MODEL_JSON, anthropicApiKey: "a-key" },
      DEMO_MODEL_JSON,
    );
    expect(selection).toEqual({ modelJson: DEMO_MODEL_JSON, provider: "anthropic" });
  });

  it("falls back to the demo pin when the Settings model's provider has no key", () => {
    expect(selectTurnModel({ modelJson: GEMINI_MODEL_JSON }, DEMO_MODEL_JSON)).toEqual({
      modelJson: DEMO_MODEL_JSON,
      provider: "anthropic",
    });
  });

  it("falls back to the demo pin when no model is configured at all", () => {
    expect(selectTurnModel({}, DEMO_MODEL_JSON)).toEqual({
      modelJson: DEMO_MODEL_JSON,
      provider: "anthropic",
    });
  });

  it("delivers the unfunded Settings model when no demo exists, so the refusal reaches the transcript", () => {
    expect(selectTurnModel({ modelJson: GEMINI_MODEL_JSON }, undefined)).toEqual({
      modelJson: GEMINI_MODEL_JSON,
      provider: "google",
    });
  });

  it("rejects an unroutable provider when no demo can stand in", () => {
    const modelJson = JSON.stringify({ provider: "mistral", id: "m" });
    expect(selectTurnModel({ modelJson }, DEMO_MODEL_JSON)).toEqual({
      modelJson: DEMO_MODEL_JSON,
      provider: "anthropic",
    });
    expect(() => selectTurnModel({ modelJson }, undefined)).toThrow(/mistral/);
  });

  it("rejects a turn with no model and no demo", () => {
    expect(() => selectTurnModel({}, undefined)).toThrow(/No model is configured/);
  });

  it("parses the fallback's provider from the fallback model itself, never assuming anthropic", () => {
    // A deployment could one day pin a non-anthropic demo model; the delivery
    // must follow the model (#53 review, finding 5).
    const openaiDemo = JSON.stringify({ provider: "openai", id: "gpt-demo" });
    expect(selectTurnModel({}, openaiDemo)).toEqual({ modelJson: openaiDemo, provider: "openai" });
    // A fallback model naming an unroutable provider is a deployment bug.
    const brokenDemo = JSON.stringify({ provider: "mistral", id: "m" });
    expect(() => selectTurnModel({}, brokenDemo)).toThrow(/unroutable provider mistral/);
  });
});

describe("ContainerTurnHost prompt", () => {
  it("seeds the full stored transcript with a fresh conversation-scoped delivery, then forwards", async () => {
    const { conversationId, container, turnState, host } = setup({ seedMessages: 2 });
    await host.prompt(conversationId, "make a box");

    expect(container.seedBodies).toHaveLength(1);
    const seed = container.seedBodies[0]!;
    expect(seed.rows?.map((row) => row.seq)).toEqual([0, 1]);
    // No settings model, demo configured: the seed delivers the demo pin.
    expect(seed.llm).toEqual({
      modelJson: DEMO_MODEL_JSON,
      provider: "anthropic",
      baseUrl: `https://proxy.example/api/llm/anthropic/${conversationId}`,
      token: `token-${conversationId}-1`,
    });
    expect(container.promptBodies).toEqual([{ text: "make a box" }]);
    expect(turnState.state.marker?.conversationId).toBe(conversationId);
    expect(turnState.state.alarmAt).toBeDefined();
    expect(host.status(conversationId).running).toBe(true);
  });

  it("delivers the user's keyed model with that provider's proxy route", async () => {
    const { db, conversationId, container, host } = setup();
    writeSettings(db, { modelJson: GEMINI_MODEL_JSON, googleApiKey: "g-key" });
    await host.prompt(conversationId, "make a box");

    expect(container.seedBodies[0]!.llm).toEqual({
      modelJson: GEMINI_MODEL_JSON,
      provider: "google",
      baseUrl: `https://proxy.example/api/llm/google/${conversationId}`,
      token: `token-${conversationId}-1`,
    });
  });

  it("a Settings model change lands on the very next prompt's delivery", async () => {
    const { db, conversationId, container, turnState, host } = setup();
    await host.prompt(conversationId, "make a box");
    expect(container.seedBodies[0]!.llm?.provider).toBe("anthropic");

    // Turn ends; the user switches Settings to a keyed Google model.
    await host.onAlarm().catch(() => {});
    turnState.state.marker = undefined;
    writeSettings(db, { modelJson: GEMINI_MODEL_JSON, googleApiKey: "g-key" });

    await host.prompt(conversationId, "make it taller");
    expect(container.seedBodies[1]!.llm).toMatchObject({
      modelJson: GEMINI_MODEL_JSON,
      provider: "google",
      baseUrl: `https://proxy.example/api/llm/google/${conversationId}`,
    });
  });

  it("mints a fresh token for every prompt, including a mid-turn follow-up", async () => {
    const { conversationId, container, turnState, host } = setup();
    await host.prompt(conversationId, "make a box");
    await host.prompt(conversationId, "make it taller");

    expect(container.seedBodies.map((seed) => seed.llm?.token)).toEqual([
      `token-${conversationId}-1`,
      `token-${conversationId}-2`,
    ]);
    expect(container.promptBodies).toHaveLength(2);
    // The follow-up rides the live turn: no second registration.
    expect(turnState.putCount()).toBe(1);
    expect(container.eventsRequests).toBe(1);
  });

  it("refuses a fusion conversation outright: Fusion is local-only (#40)", async () => {
    const { container, host, db } = setup();
    const fusion = createConversation(db, "fusion design", "fusion");
    await expect(host.prompt(fusion.id, "make a bracket")).rejects.toThrow(/Fusion is local-only/);
    // The container was never touched - no seed, no prompt, no minted token.
    expect(container.seedBodies).toHaveLength(0);
    expect(container.promptBodies).toHaveLength(0);
    expect(host.status(fusion.id).running).toBe(false);
  });

  it("refuses a second conversation while a turn runs (turns serialize per container)", async () => {
    const { conversationId, container, host, db } = setup();
    const other = createConversation(db, "other");
    await host.prompt(conversationId, "make a box");
    await expect(host.prompt(other.id, "another thing")).rejects.toThrow(/one at a time/);
    expect(container.seedBodies).toHaveLength(1);
  });

  it("does not register a turn when the container rejects the prompt", async () => {
    const { conversationId, container, turnState, host } = setup();
    container.fetch = async (path) => {
      if (path.endsWith("/seed")) return json({ ok: true, appended: 0, maxSeq: -1 });
      return json({ error: "model not configured" }, 502);
    };
    await expect(host.prompt(conversationId, "make a box")).rejects.toThrow(/model not configured/);
    expect(turnState.state.marker).toBeUndefined();
    expect(host.status(conversationId).running).toBe(false);
  });
});

describe("ContainerTurnHost relay and drain", () => {
  it("emits a running snapshot to browsers the moment a turn begins", async () => {
    // The container's agent_start fires before the DO's watcher subscribes to
    // the container stream, so it never reaches an already-connected browser.
    // Without a synthetic snapshot at turn start the browser's status sits on
    // "Done" for the whole run. This is the mirror of the running:false emit at
    // turn completion.
    const { conversationId, host, events } = setup();
    await host.prompt(conversationId, "make a box");
    expect(events[0]).toEqual({ type: "agent_status", running: true, startedAt: expect.any(Number) });
    // And the browser-facing status the route serves also reads running.
    expect(host.status(conversationId).running).toBe(true);
  });

  it("arms the event relay before POSTing the prompt so no early event is dropped", async () => {
    // The lossless-relay guarantee: /events (the watcher's subscription) is
    // opened while the container is still idle, BEFORE /messages starts the
    // turn. The container subscribes this watcher on connect, so the agent_start
    // the POST triggers is captured instead of firing into a stream nobody is
    // reading yet. The prompt POST also does not land until the watcher has seen
    // its readiness snapshot.
    const { conversationId, container, host } = setup();
    await host.prompt(conversationId, "make a box");
    const events = container.callLog.indexOf("events");
    const messages = container.callLog.indexOf("messages");
    expect(events).toBeGreaterThanOrEqual(0);
    expect(messages).toBeGreaterThan(events);
    // And an agent_start pushed the instant the turn starts reaches the browser -
    // the very event the old ordering dropped.
    const seen: string[] = [];
    host.subscribe(conversationId, (event) => seen.push(event.type));
    container.sse.frame({ type: "agent_start" });
    await vi.waitFor(() => expect(seen).toContain("agent_start"));
  });

  it("relays container events to subscribers and drains transcript plus artifact at agent_settled", async () => {
    const { db, conversationId, container, turnState, artifacts, host, events } = setup({ seedMessages: 1 });
    await host.prompt(conversationId, "make a box");
    await vi.waitFor(() => expect(container.eventsRequests).toBe(1));

    container.sse.frame({ type: "agent_status", running: true });
    container.sse.frame({ type: "agent_start" });
    container.sse.frame({ type: "message_start", role: "assistant" });
    // The turn's rows land in the container's scratch store before the turn
    // settles on the wire, exactly like the real session host behaves.
    container.rows.push(
      { id: "r-1", seq: 1, role: "user", contentJson: JSON.stringify({ role: "user", content: [] }) },
      { id: "r-2", seq: 2, role: "assistant", contentJson: JSON.stringify({ role: "assistant", content: [] }) },
    );
    container.artifact = { revision: 4200, bytes: new TextEncoder().encode("solid box") };
    // agent_end is an internal run boundary, NOT turn completion: the drain
    // must wait for agent_settled or a compact-and-retry continuation would be
    // orphaned mid-turn.
    container.sse.frame({ type: "agent_end", messages: [] });
    container.sse.frame({ type: "agent_settled" });

    await vi.waitFor(() => expect(turnState.state.marker).toBeUndefined());

    // Events reached the browser channel in order: the DO's own running:true
    // snapshot at turn start (so an already-connected browser flips to
    // "working"), the forwarded run events, then the running:false snapshot at
    // completion. The container's connect-time snapshot stays host-internal.
    expect(events.map((event) => event.type)).toEqual([
      "agent_status",
      "agent_start",
      "message_start",
      "agent_end",
      "agent_settled",
      "artifact_updated",
      "agent_status",
    ]);
    expect(events[0]).toMatchObject({ type: "agent_status", running: true });
    expect(events.at(-1)).toMatchObject({ type: "agent_status", running: false });
    // Transcript rows landed verbatim (ids and seqs preserved).
    const drained = listMessages(db, conversationId);
    expect(drained.map((row) => [row.id, row.seq, row.role])).toEqual([
      [drained[0]!.id, 0, "user"],
      ["r-1", 1, "user"],
      ["r-2", 2, "assistant"],
    ]);
    // Artifact bytes left the container into the store, keyed by its rewrite signal.
    expect(artifacts.written).toEqual([
      { conversationId, mtimeMs: 4200, bytes: new TextEncoder().encode("solid box") },
    ]);
    expect(turnState.state.alarmAt).toBeUndefined();
    expect(host.status(conversationId)).toEqual({ running: false });
  });

  it("keeps the turn alive across agent_end with willRetry", async () => {
    const { conversationId, container, turnState, host } = setup();
    await host.prompt(conversationId, "make a box");
    await vi.waitFor(() => expect(container.eventsRequests).toBe(1));
    container.sse.frame({ type: "agent_start" });
    container.sse.frame({ type: "agent_end", willRetry: true, messages: [] });
    container.sse.frame({ type: "message_start" });
    await vi.waitFor(() => expect(host.status(conversationId).running).toBe(true));
    expect(turnState.state.marker).toBeDefined();
  });

  it("does NOT complete the turn on a plain agent_end (a continuation may follow)", async () => {
    const { conversationId, container, turnState, host } = setup();
    await host.prompt(conversationId, "make a box");
    await vi.waitFor(() => expect(container.eventsRequests).toBe(1));
    container.sse.frame({ type: "agent_start" });
    // A non-retry agent_end that pi follows with an overflow-compaction
    // continuation: the DO must keep the turn live, or it would drain and
    // cancel the alarm while the container is still working.
    container.sse.frame({ type: "agent_end", willRetry: false, messages: [] });
    container.sse.frame({ type: "compaction_start", reason: "overflow" });
    container.sse.frame({ type: "agent_start" });
    container.sse.frame({ type: "tool_execution_start", toolCallId: "t1", toolName: "execute", args: {} });
    // Give the watcher time to (wrongly) complete if the rule regressed.
    await vi.waitFor(() => expect(host.status(conversationId).activeTool?.name).toBe("execute"));
    expect(host.status(conversationId).running).toBe(true);
    expect(turnState.state.marker).toBeDefined();
  });

  it("copies a mid-turn artifact rewrite into the store before telling browsers", async () => {
    const { conversationId, container, artifacts, host, events } = setup();
    await host.prompt(conversationId, "make a box");
    await vi.waitFor(() => expect(container.eventsRequests).toBe(1));
    container.artifact = { revision: 1111, bytes: new TextEncoder().encode("solid v1") };
    container.sse.frame({ type: "artifact_updated", revision: 1111 });
    await vi.waitFor(() => expect(events.some((event) => event.type === "artifact_updated")).toBe(true));
    // Forwarded with the store's revision (what the artifact route serves),
    // not the container-local one - and the bytes are already in the store.
    expect(events.at(-1)).toEqual({ type: "artifact_updated", revision: 1 });
    expect(artifacts.written[0]?.mtimeMs).toBe(1111);
  });

  it("treats a run-fatal agent_error as turn completion and still drains", async () => {
    const { conversationId, container, turnState, host, events } = setup();
    await host.prompt(conversationId, "make a box");
    await vi.waitFor(() => expect(container.eventsRequests).toBe(1));
    container.sse.frame({ type: "agent_error", message: "boom" });
    await vi.waitFor(() => expect(turnState.state.marker).toBeUndefined());
    expect(events.some((event) => event.type === "agent_error")).toBe(true);
  });

  it("proxies abort only while its conversation's turn is live", async () => {
    const { conversationId, container, host, db } = setup();
    await host.abort(conversationId);
    expect(container.abortCount).toBe(0);
    await host.prompt(conversationId, "make a box");
    const other = createConversation(db, "other");
    await host.abort(other.id);
    expect(container.abortCount).toBe(0);
    await host.abort(conversationId);
    expect(container.abortCount).toBe(1);
  });
});

describe("ContainerTurnHost alarm safety net", () => {
  it("re-arms while the container reports the run live", async () => {
    const { conversationId, container, turnState, host } = setup();
    turnState.state.marker = { conversationId, startedAtMs: Date.now() };
    container.status = { running: true };
    await host.onAlarm();
    expect(turnState.state.alarmAt).toBeDefined();
    expect(turnState.state.marker).toBeDefined();
    // The alarm also restarts a watcher so browsers regain the live relay.
    await vi.waitFor(() => expect(container.eventsRequests).toBe(1));
  });

  it("drains and clears once the run is over, with no watcher and no browser", async () => {
    const { db, conversationId, container, turnState, artifacts, host } = setup();
    turnState.state.marker = { conversationId, startedAtMs: Date.now() };
    container.rows.push({ id: "r-0", seq: 0, role: "user", contentJson: JSON.stringify({ role: "user" }) });
    container.artifact = { revision: 99, bytes: new TextEncoder().encode("solid") };
    await host.onAlarm();
    expect(turnState.state.marker).toBeUndefined();
    expect(listMessages(db, conversationId).map((row) => row.id)).toEqual(["r-0"]);
    expect(artifacts.written).toHaveLength(1);
  });

  it("clears the turn when the container came back fresh (nothing to drain)", async () => {
    const { conversationId, container, turnState, host } = setup();
    turnState.state.marker = { conversationId, startedAtMs: Date.now() };
    container.transcript404 = true;
    await host.onAlarm();
    expect(turnState.state.marker).toBeUndefined();
    expect(host.status(conversationId).running).toBe(false);
  });

  it("force-drains a turn past its hard deadline even if the run claims to be live", async () => {
    const { conversationId, container, turnState, host } = setup();
    turnState.state.marker = { conversationId, startedAtMs: Date.now() - DEFAULT_DEADLINE_MS - 1 };
    container.status = { running: true };
    await host.onAlarm();
    expect(turnState.state.marker).toBeUndefined();
  });

  it("retries later when the container is unreachable inside the deadline", async () => {
    const { conversationId, container, turnState, host } = setup();
    turnState.state.marker = { conversationId, startedAtMs: Date.now() };
    container.fetch = async () => {
      throw new Error("network down");
    };
    await host.onAlarm();
    expect(turnState.state.marker).toBeDefined();
    expect(turnState.state.alarmAt).toBeDefined();
  });
});

describe("ContainerTurnHost restore", () => {
  it("resumes watching a live turn and reports it running", async () => {
    const { conversationId, container, turnState, host } = setup();
    turnState.state.marker = { conversationId, startedAtMs: Date.now() };
    // A genuinely live turn: the container's connect-time snapshot reports the
    // run still going, so the restored watcher keeps it alive instead of draining.
    container.status = { running: true };
    await host.restore();
    expect(host.status(conversationId).running).toBe(true);
    await vi.waitFor(() => expect(container.eventsRequests).toBe(1));
    // The turn stays live: the running snapshot does not trip the finish-on-idle drain.
    expect(turnState.state.marker).toBeDefined();
  });

  it("drains immediately when the restored turn already ended while the DO was away", async () => {
    const { db, conversationId, container, turnState, host } = setup();
    turnState.state.marker = { conversationId, startedAtMs: Date.now() };
    container.rows.push({ id: "r-0", seq: 0, role: "user", contentJson: JSON.stringify({ role: "user" }) });
    // The container's connect-time snapshot (running:false by default) says the
    // run is over; the restored watcher drains on it without any further frame.
    await host.restore();
    await vi.waitFor(() => expect(turnState.state.marker).toBeUndefined());
    expect(container.eventsRequests).toBe(1);
    expect(listMessages(db, conversationId).map((row) => row.id)).toEqual(["r-0"]);
    expect(host.status(conversationId)).toEqual({ running: false });
  });
});
