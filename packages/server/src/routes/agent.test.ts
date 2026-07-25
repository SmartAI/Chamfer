import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../db";
import { createApp } from "../app";
import { createConversation } from "../conversationStore";
import { agentRoutes, type AgentSessionHost } from "./agent";
import type { AgentServerEvent } from "../agent/piSession";
import type { ArtifactStore } from "../agent/artifactStore";
import { AgentStatusTracker } from "../agent/agentStatus";

function fakeHost(overrides: Partial<AgentSessionHost> = {}): AgentSessionHost {
  return {
    prompt: async () => {},
    abort: async () => {},
    subscribe: () => () => {},
    status: () => ({ running: false }),
    ...overrides,
  };
}

function fakeStore(overrides: Partial<ArtifactStore> = {}): ArtifactStore {
  return {
    record: async (_conversationId, exportFile) => ({ revision: Math.floor(exportFile.mtimeMs), updated: false }),
    current: async () => undefined,
    exists: async () => false,
    ...overrides,
  };
}

/** First SSE data frame of the events stream, parsed. */
async function firstEventFrame(response: Response): Promise<AgentServerEvent> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frame = buffer.split("\n\n").find((part) => part.includes("data: "));
    if (frame) {
      await reader.cancel();
      const dataLine = frame.split("\n").find((line) => line.startsWith("data: "))!;
      return JSON.parse(dataLine.slice(6)) as AgentServerEvent;
    }
  }
  throw new Error("stream ended without a data frame");
}

describe("agent events route", () => {
  it("a connect mid-turn receives a running:true status snapshot first", async () => {
    const db = openDb(":memory:");
    const conversation = createConversation(db, "New chat", "build123d");
    const startedAt = Date.now() - 60_000;
    const app = agentRoutes(db, fakeHost({
      status: () => ({
        running: true,
        startedAt,
        activeTool: { name: "fusion_mcp_execute", startedAt },
      }),
    }), fakeStore());

    const response = await app.request(`/api/agent/${conversation.id}/events`);
    expect(response.status).toBe(200);
    const first = await firstEventFrame(response);
    expect(first).toEqual({
      type: "agent_status",
      running: true,
      startedAt,
      activeTool: { name: "fusion_mcp_execute", startedAt },
    });
  });

  it("an idle connect receives a running:false snapshot", async () => {
    const db = openDb(":memory:");
    const conversation = createConversation(db, "New chat", "build123d");
    const app = agentRoutes(db, fakeHost(), fakeStore());

    const response = await app.request(`/api/agent/${conversation.id}/events`);
    const first = await firstEventFrame(response);
    expect(first).toEqual({ type: "agent_status", running: false });
  });

  it("404s the stream for an unknown conversation", async () => {
    const db = openDb(":memory:");
    const app = agentRoutes(db, fakeHost(), fakeStore());
    expect((await app.request("/api/agent/nope/events")).status).toBe(404);
  });
});

describe("agent artifact route", () => {
  const encoder = new TextEncoder();

  function appWithCurrent(current: NonNullable<Awaited<ReturnType<ArtifactStore["current"]>>> | undefined) {
    const db = openDb(":memory:");
    const conversation = createConversation(db, "New chat", "build123d");
    const app = agentRoutes(db, fakeHost(), fakeStore({ current: async () => current }));
    return { app, conversationId: conversation.id };
  }

  it("serves the store's current bytes with revision-keyed caching headers", async () => {
    const { app, conversationId } = appWithCurrent({
      revision: 1234,
      bytes: async () => encoder.encode("solid cube"),
    });
    const response = await app.request(`/api/agent/${conversationId}/artifact`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("model/stl");
    expect(response.headers.get("etag")).toBe('"artifact-r1234"');
    expect(response.headers.get("x-artifact-revision")).toBe("1234");
    expect(await response.text()).toBe("solid cube");
  });

  it("304s a matching If-None-Match without reading bytes", async () => {
    let reads = 0;
    const { app, conversationId } = appWithCurrent({
      revision: 1234,
      bytes: async () => {
        reads += 1;
        return encoder.encode("solid cube");
      },
    });
    const response = await app.request(`/api/agent/${conversationId}/artifact`, {
      headers: { "if-none-match": '"artifact-r1234"' },
    });
    expect(response.status).toBe(304);
    expect(reads).toBe(0);
  });

  it("404s when the store has no artifact, and for unknown conversations", async () => {
    const { app, conversationId } = appWithCurrent(undefined);
    const response = await app.request(`/api/agent/${conversationId}/artifact`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "no artifact" });
    expect((await app.request("/api/agent/nope/artifact")).status).toBe(404);
  });

  it("404s when the bytes vanish between revision check and read", async () => {
    const { app, conversationId } = appWithCurrent({
      revision: 1234,
      bytes: async () => {
        throw new Error("gone");
      },
    });
    const response = await app.request(`/api/agent/${conversationId}/artifact`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "artifact file missing" });
  });
});

describe("agent artifact route wired through the local store", () => {
  const dataDirs: string[] = [];
  afterEach(() => {
    for (const dir of dataDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** Pins the pre-seam local behavior byte for byte: same route, mtime-derived
   * revision, same headers, 304 on the revision ETag. */
  it("serves a real export with its mtime as the revision", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "chamfer-agent-route-"));
    dataDirs.push(dataDir);
    const app = createApp(openDb(":memory:"), undefined, { dataDir });
    const created = await app.request("/api/conversations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Bracket", cadEnvironment: "build123d" }),
    });
    const { id } = (await created.json()) as { id: string };

    expect((await app.request(`/api/agent/${id}/artifact`)).status).toBe(404);

    const dir = join(dataDir, "agent", id);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "artifact.stl");
    writeFileSync(path, "solid part");
    utimesSync(path, new Date(5_000), new Date(5_000));

    const response = await app.request(`/api/agent/${id}/artifact`);
    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBe('"artifact-r5000"');
    expect(response.headers.get("x-artifact-revision")).toBe("5000");
    expect(await response.text()).toBe("solid part");

    const cached = await app.request(`/api/agent/${id}/artifact`, {
      headers: { "if-none-match": '"artifact-r5000"' },
    });
    expect(cached.status).toBe(304);
  });
});

describe("agent status tracking", () => {
  it("keys running only on agent_start/agent_settled and tracks the active tool", () => {
    const tracker = new AgentStatusTracker();
    expect(tracker.snapshot()).toEqual({ running: false });

    tracker.apply({ type: "agent_start" });
    expect(tracker.snapshot().running).toBe(true);

    tracker.apply({ type: "message_end" });
    tracker.apply({ type: "turn_end" });
    expect(tracker.snapshot().running).toBe(true);

    tracker.apply({ type: "tool_execution_start", toolName: "fusion_mcp_execute" });
    expect(tracker.snapshot().activeTool?.name).toBe("fusion_mcp_execute");

    tracker.apply({ type: "tool_execution_end", toolName: "fusion_mcp_execute" });
    expect(tracker.snapshot().activeTool).toBeUndefined();
    expect(tracker.snapshot().running).toBe(true);

    // An internal agent_end is not the end of the turn: pi continues the same
    // run (retry, overflow compact-and-retry), so the status stays running and
    // only the active tool is cleared.
    tracker.apply({ type: "agent_end" });
    expect(tracker.snapshot().running).toBe(true);

    // agent_settled is pi's once-per-prompt settlement signal.
    tracker.apply({ type: "agent_settled" });
    expect(tracker.snapshot()).toEqual({ running: false });
  });
});
