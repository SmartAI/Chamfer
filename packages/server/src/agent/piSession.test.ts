import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore, type Api, type Model } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../db";
import { writeSettings } from "../settingsStore";
import { createConversation, listMessages } from "../conversationStore";
import { appendStoredMessages, persistTurnTranscript, seedSessionFromStore } from "./turnPersistence";
import { PiAgentSessions, type AgentServerEvent } from "./piSession";

/** Fires a session event through the private handler: a real pi session needs
 * a configured model and a live MCP adapter, which unit tests must not. */
function fireSessionEvent(sessions: PiAgentSessions, conversationId: string, dir: string, event: unknown): void {
  (sessions as unknown as {
    onSessionEvent(conversationId: string, environment: string, dir: string, event: unknown): void;
  }).onSessionEvent(conversationId, "build123d", dir, event);
}

/** Drives the private watermark seed createAgent runs at session open. */
function seedArtifactWatermark(sessions: PiAgentSessions, conversationId: string, dir: string): Promise<void> {
  return (sessions as unknown as {
    seedArtifactWatermark(conversationId: string, dir: string): Promise<void>;
  }).seedArtifactWatermark(conversationId, dir);
}

/** Drives the private prompt-persistence step without a live pi session; the
 * in-flight decision it makes is what these tests exercise. */
function recordPrompt(sessions: PiAgentSessions, conversationId: string, content: unknown[]): void {
  (sessions as unknown as {
    recordPrompt(conversationId: string, content: unknown[]): void;
  }).recordPrompt(conversationId, content);
}

const CAD_CODE = "from build123d import *\nresult = Box(10, 20, 30)";

describe("agent_end transcript persistence", () => {
  const dataDirs: string[] = [];
  afterEach(() => {
    for (const dir of dataDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function setup() {
    const dataDir = mkdtempSync(join(tmpdir(), "chamfer-pi-session-"));
    dataDirs.push(dataDir);
    const db = openDb(":memory:");
    const conversation = createConversation(db, "New chat", "build123d");
    const sessions = new PiAgentSessions(db, dataDir);
    return { db, conversationId: conversation.id, sessions, dir: join(dataDir, "agent", conversation.id) };
  }

  it("persists the whole turn in order and keeps the executed CAD code recoverable", () => {
    const { db, conversationId, sessions, dir } = setup();
    const promptContent = [{ type: "text", text: "make a box" }];
    const turn = [
      // pi re-stamps the prompt's timestamp; the eager row must still match.
      { role: "user", content: promptContent, timestamp: 999 },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Building it now." },
          { type: "toolCall", id: "call-1", name: "execute", arguments: { code: CAD_CODE } },
        ],
        stopReason: "toolUse",
      },
      { role: "toolResult", toolCallId: "call-1", toolName: "execute", content: [{ type: "text", text: "ok" }] },
      { role: "assistant", content: [{ type: "text", text: "Done: a 10x20x30 box." }], stopReason: "stop" },
    ];
    recordPrompt(sessions, conversationId, promptContent);
    fireSessionEvent(sessions, conversationId, dir, { type: "agent_start" });
    fireSessionEvent(sessions, conversationId, dir, { type: "agent_end", messages: turn, willRetry: false });

    const rows = listMessages(db, conversationId);
    expect(rows.map((row) => row.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
    expect(rows.map((row) => row.seq)).toEqual([0, 1, 2, 3]);
    expect(rows[0]?.contentJson).toContain("make a box");
    const codeRow = rows.find((row) => row.contentJson.includes("Box(10, 20, 30)"));
    expect(codeRow?.role).toBe("assistant");
    expect(JSON.parse(rows[2]!.contentJson)).toEqual(turn[2]);
  });

  it("keeps the turn (and the executed CAD code) when a user attaches an oversized image", () => {
    const { db, conversationId, sessions, dir } = setup();
    // A raw phone photo, base64-encoded, blows past the 1 MB conversation-event
    // cap. Before the resilience fix the whole turn silently failed to persist,
    // so the conversation showed in the list but reopened with no history.
    const oversizedImage = "A".repeat(1_500_000);
    const promptContent = [
      { type: "text", text: "make a glass like this photo" },
      { type: "image", data: oversizedImage, mimeType: "image/jpeg" },
    ];
    recordPrompt(sessions, conversationId, promptContent);
    fireSessionEvent(sessions, conversationId, dir, { type: "agent_start" });
    fireSessionEvent(sessions, conversationId, dir, {
      type: "agent_end",
      willRetry: false,
      messages: [
        { role: "user", content: promptContent, timestamp: 1 },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Building it now." },
            { type: "toolCall", id: "call-1", name: "execute", arguments: { code: CAD_CODE } },
          ],
          stopReason: "toolUse",
        },
        { role: "toolResult", toolCallId: "call-1", toolName: "execute", content: [{ type: "text", text: "ok" }] },
        { role: "assistant", content: [{ type: "text", text: "Done." }], stopReason: "stop" },
      ],
    });

    const rows = listMessages(db, conversationId);
    // The turn survives in order, with exactly one user row (eager, deduped).
    expect(rows.map((row) => row.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
    // The prompt text is kept; the oversized image is dropped to a placeholder
    // rather than taking the whole turn down with it.
    expect(rows[0]?.contentJson).toContain("make a glass like this photo");
    expect(rows[0]?.contentJson).not.toContain(oversizedImage);
    expect(rows[0]!.contentJson.length).toBeLessThan(1_000_000);
    // The generated build123d code is durable.
    expect(rows.some((row) => row.contentJson.includes("Box(10, 20, 30)"))).toBe(true);
  });

  it("stores a follow-up queued mid-run at its true transcript position", () => {
    const { db, conversationId, sessions, dir } = setup();
    const initialContent = [{ type: "text", text: "make a box" }];
    const followUpContent = [{ type: "text", text: "make it taller" }];
    recordPrompt(sessions, conversationId, initialContent);
    fireSessionEvent(sessions, conversationId, dir, { type: "agent_start" });
    // Sent while the run streams: pi queues it, so no eager row lands here.
    recordPrompt(sessions, conversationId, followUpContent);
    fireSessionEvent(sessions, conversationId, dir, {
      type: "agent_end",
      willRetry: false,
      messages: [
        { role: "user", content: initialContent, timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: "built" }], stopReason: "stop" },
        { role: "toolResult", toolCallId: "tc-1", toolName: "execute", content: [{ type: "text", text: "ok" }] },
        { role: "user", content: followUpContent, timestamp: 2 },
        { role: "assistant", content: [{ type: "text", text: "taller now" }], stopReason: "stop" },
      ],
    });

    const rows = listMessages(db, conversationId);
    expect(rows.map((row) => row.role)).toEqual(["user", "assistant", "toolResult", "user", "assistant"]);
    expect(rows[3]?.contentJson).toContain("make it taller");
    // Exactly one copy of each user message: the queued one was not persisted eagerly.
    expect(rows.filter((row) => row.contentJson.includes("make a box"))).toHaveLength(1);
    expect(rows.filter((row) => row.contentJson.includes("make it taller"))).toHaveLength(1);
  });

  it("pending eager rows do not leak into the next turn's dedupe", () => {
    const { db, conversationId, sessions, dir } = setup();
    const content = [{ type: "text", text: "make a box" }];
    recordPrompt(sessions, conversationId, content);
    fireSessionEvent(sessions, conversationId, dir, { type: "agent_start" });
    fireSessionEvent(sessions, conversationId, dir, {
      type: "agent_end",
      willRetry: false,
      messages: [
        { role: "user", content, timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: "built" }], stopReason: "stop" },
      ],
    });
    // Identical prompt next turn: its own eager row must be consumed by its
    // own agent_end, not skipped against a stale pending entry.
    recordPrompt(sessions, conversationId, content);
    fireSessionEvent(sessions, conversationId, dir, { type: "agent_start" });
    fireSessionEvent(sessions, conversationId, dir, {
      type: "agent_end",
      willRetry: false,
      messages: [
        { role: "user", content, timestamp: 2 },
        { role: "assistant", content: [{ type: "text", text: "another box" }], stopReason: "stop" },
      ],
    });

    const rows = listMessages(db, conversationId);
    expect(rows.map((row) => row.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });

  it("appends a retry continuation's agent_end after the first without duplicates", () => {
    const { db, conversationId, sessions, dir } = setup();
    fireSessionEvent(sessions, conversationId, dir, {
      type: "agent_end",
      willRetry: true,
      messages: [{ role: "assistant", content: [{ type: "text", text: "" }], stopReason: "error", errorMessage: "overloaded" }],
    });
    fireSessionEvent(sessions, conversationId, dir, {
      type: "agent_end",
      willRetry: false,
      messages: [{ role: "assistant", content: [{ type: "text", text: "recovered" }], stopReason: "stop" }],
    });
    const rows = listMessages(db, conversationId);
    expect(rows.map((row) => row.role)).toEqual(["assistant", "assistant"]);
    expect(rows[1]?.contentJson).toContain("recovered");
  });
});

describe("artifact turn-end recording", () => {
  const dataDirs: string[] = [];
  afterEach(() => {
    for (const dir of dataDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function setup() {
    const dataDir = mkdtempSync(join(tmpdir(), "chamfer-pi-artifact-"));
    dataDirs.push(dataDir);
    const db = openDb(":memory:");
    const conversation = createConversation(db, "New chat", "build123d");
    const sessions = new PiAgentSessions(db, dataDir);
    return { conversationId: conversation.id, sessions, dir: join(dataDir, "agent", conversation.id) };
  }

  /** Rewrites the contracted export at an explicit mtime: rewrites land at
   * later mtimes in production, and the explicit clock keeps the mtime-derived
   * revision deterministic. */
  function writeArtifact(dir: string, content: string, mtimeMs: number): void {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "artifact.stl");
    writeFileSync(path, content);
    utimesSync(path, new Date(mtimeMs), new Date(mtimeMs));
  }

  /** record() resolves in a microtask for the local store; one macrotask
   * flush makes the artifact_updated emission observable. */
  function settle(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
  }

  function updatesOf(events: AgentServerEvent[]): number[] {
    return events.flatMap((event) => (event.type === "artifact_updated" ? [event.revision] : []));
  }

  it("emits artifact_updated once per rewrite, keyed on the store revision", async () => {
    const { conversationId, sessions, dir } = setup();
    const events: AgentServerEvent[] = [];
    sessions.subscribe(conversationId, (event) => events.push(event));

    writeArtifact(dir, "solid a", 1_000);
    fireSessionEvent(sessions, conversationId, dir, { type: "turn_end" });
    await settle();
    expect(updatesOf(events)).toEqual([1_000]);

    // agent_end after the same turn re-checks the unchanged export: silent.
    fireSessionEvent(sessions, conversationId, dir, { type: "agent_end", messages: [], willRetry: false });
    await settle();
    expect(updatesOf(events)).toEqual([1_000]);

    writeArtifact(dir, "solid b", 2_000);
    fireSessionEvent(sessions, conversationId, dir, { type: "turn_end" });
    await settle();
    expect(updatesOf(events)).toEqual([1_000, 2_000]);
  });

  it("a watermark seeded at session open keeps a reopened conversation quiet", async () => {
    const { conversationId, sessions, dir } = setup();
    writeArtifact(dir, "solid a", 1_000);
    await seedArtifactWatermark(sessions, conversationId, dir);

    const events: AgentServerEvent[] = [];
    sessions.subscribe(conversationId, (event) => events.push(event));
    fireSessionEvent(sessions, conversationId, dir, { type: "turn_end" });
    await settle();
    expect(updatesOf(events)).toEqual([]);

    writeArtifact(dir, "solid b", 2_000);
    fireSessionEvent(sessions, conversationId, dir, { type: "turn_end" });
    await settle();
    expect(updatesOf(events)).toEqual([2_000]);
  });
});

/** Minimal Anthropic Messages SSE stub: records each request's model id and
 * answers a one-line text turn (the same frame shapes the container smoke's
 * fakeAnthropic.mjs uses against real pi). */
function startAnthropicStub(): Promise<{ server: Server; port: number; models: string[] }> {
  const models: string[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => {
      raw += chunk;
    });
    req.on("end", () => {
      models.push((JSON.parse(raw) as { model: string }).model);
      const usage = { input_tokens: 1, output_tokens: 1 };
      const frames = [
        {
          type: "message_start",
          message: {
            id: "msg_stub", type: "message", role: "assistant", model: "stub",
            content: [], stop_reason: null, stop_sequence: null, usage,
          },
        },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      ];
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const frame of frames) res.write(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`);
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, port: typeof address === "object" && address ? address.port : 0, models });
    });
  });
}

function stubModel(id: string, baseUrl: string): Model<Api> {
  return {
    id,
    name: id,
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 4096,
  } as Model<Api>;
}

function waitForAgentEnd(session: AgentSession, timeoutMs = 30_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for agent_end")), timeoutMs);
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "agent_end") {
        clearTimeout(timer);
        unsubscribe();
        resolve();
      }
    });
  });
}

/** The two tests below are integration tests: they stand up a real localhost
 * HTTP server and a real pi AgentSession and wait on real request/response
 * round-trips (or, for refreshCredentials, a real ModelRuntime build). In
 * isolation each finishes in well under 2s, but the full server suite runs ~80
 * files in parallel, and on a small, fully loaded CI runner the worker's event
 * loop is starved during that collect/transform storm - the round-trips can
 * then blow past a fixed deadline (they timed out even at 30s once, which is
 * why simply bumping the timeout in #68 did not hold). A generous timeout plus
 * a bounded retry re-runs each attempt in a fresh window once the storm
 * subsides, the correct remedy for real-I/O flakiness. */
const INTEGRATION_TEST_OPTS = { timeout: 30_000, retry: 2 } as const;

describe("model switching (issue #53)", () => {
  const dataDirs: string[] = [];
  afterEach(() => {
    for (const dir of dataDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** Contract test against pi itself: model identity is captured at session
   * build (agent.state.model), and AgentSession.setModel is the supported,
   * provider-agnostic switch - the next LLM request must carry the new model.
   * This is the mechanism refreshCredentials relies on for a warm container
   * receiving a different per-turn model. */
  it("setModel changes which model the next LLM request names", INTEGRATION_TEST_OPTS, async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "chamfer-pi-setmodel-"));
    dataDirs.push(dataDir);
    const dir = join(dataDir, "agent", "conv");
    mkdirSync(dir, { recursive: true });
    const { server, port, models } = await startAnthropicStub();
    try {
      const baseUrl = `http://127.0.0.1:${port}`;
      const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null });
      await runtime.setRuntimeApiKey("anthropic", "stub-key");
      const resourceLoader = new DefaultResourceLoader({
        cwd: dir,
        agentDir: join(dataDir, "pi-agent"),
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        systemPrompt: "test prompt",
      });
      await resourceLoader.reload();
      const { session } = await createAgentSession({
        cwd: dir,
        model: stubModel("model-x", baseUrl),
        modelRuntime: runtime,
        noTools: "all",
        resourceLoader,
        sessionManager: SessionManager.inMemory(dir),
        settingsManager: SettingsManager.inMemory(),
      });
      try {
        const firstTurn = waitForAgentEnd(session);
        void session.prompt("hi");
        await firstTurn;
        expect(models).toEqual(["model-x"]);

        await session.setModel(stubModel("model-y", baseUrl));
        const secondTurn = waitForAgentEnd(session);
        void session.prompt("again");
        await secondTurn;
        expect(models).toEqual(["model-x", "model-y"]);
      } finally {
        session.dispose();
      }
    } finally {
      server.close();
    }
  });

  /** The host-side half: refreshCredentials propagates a changed effective
   * settings model onto live sessions through setModel, and leaves an
   * identical model alone. */
  it("refreshCredentials switches live sessions only when the settings model differs", INTEGRATION_TEST_OPTS, async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "chamfer-pi-refresh-"));
    dataDirs.push(dataDir);
    const db = openDb(":memory:");
    const conversation = createConversation(db, "New chat", "build123d");
    const sessions = new PiAgentSessions(db, dataDir);
    const modelY = stubModel("model-y", "http://127.0.0.1:1");
    writeSettings(db, { modelJson: JSON.stringify(modelY), anthropicApiKey: "key" });

    const setModel = vi.fn(async (_model: unknown) => {});
    const fakeAgent = {
      session: { model: stubModel("model-x", "http://127.0.0.1:1"), setModel },
      environment: "build123d",
      dir: join(dataDir, "agent", conversation.id),
    };
    (sessions as unknown as { agents: Map<string, Promise<unknown>> }).agents.set(
      conversation.id,
      Promise.resolve(fakeAgent),
    );

    await sessions.refreshCredentials();
    expect(setModel).toHaveBeenCalledTimes(1);
    expect(setModel.mock.calls[0]![0]).toMatchObject({ id: "model-y", provider: "anthropic" });

    // Same model next delivery (the common per-turn token rotation): no switch.
    setModel.mockClear();
    fakeAgent.session.model = stubModel("model-y", "http://127.0.0.1:1");
    await sessions.refreshCredentials();
    expect(setModel).not.toHaveBeenCalled();
  });
});

describe("session reseeding", () => {
  const dataDirs: string[] = [];
  afterEach(() => {
    for (const dir of dataDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** Contract test against pi's native resume path: createAgentSession must
   * restore agent.state.messages from a SessionManager pre-populated by
   * seedSessionFromStore, exactly as it does for its own JSONL session files.
   * PiAgentSessions.buildSession is not driven here because it loads the MCP
   * adapter extension and waits on live CAD servers; the seeded-manager ->
   * createAgentSession seam is the part this increment adds. */
  it("starts a rebuilt pi session with the stored transcript in agent state", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "chamfer-pi-reseed-"));
    dataDirs.push(dataDir);
    const db = openDb(":memory:");
    const conversation = createConversation(db, "New chat", "build123d");
    const dir = join(dataDir, "agent", conversation.id);
    mkdirSync(dir, { recursive: true });
    const userMessage = { role: "user", content: [{ type: "text", text: "make a box" }], timestamp: 1 };
    const transcript = [
      userMessage,
      { role: "assistant", content: [{ type: "text", text: "Done: a 10x20x30 box." }], stopReason: "stop", timestamp: 2 },
    ];
    appendStoredMessages(db, conversation.id, [userMessage]);
    persistTurnTranscript(db, conversation.id, transcript, [JSON.stringify(userMessage.content)]);

    const sessionManager = seedSessionFromStore(db, conversation.id, () => SessionManager.inMemory(dir));
    const resourceLoader = new DefaultResourceLoader({
      cwd: dir,
      agentDir: join(dataDir, "pi-agent"),
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: "test prompt",
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd: dir,
      modelRuntime: await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null }),
      noTools: "all",
      resourceLoader,
      sessionManager,
      settingsManager: SettingsManager.inMemory(),
    });
    try {
      expect(session.agent.state.messages).toEqual(transcript);
    } finally {
      session.dispose();
    }
  });
});
