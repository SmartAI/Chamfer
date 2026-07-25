import { describe, expect, it } from "vitest";
import { openDb } from "../db";
import { getConversation, listMessages } from "../conversationStore";
import type { AgentSessionHost } from "../routes/agent";
import type { ArtifactStore } from "../agent/artifactStore";
import { createContainerApp } from "./app";

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

function seedRow(seq: number, role: string, text: string, id?: string) {
  return { ...(id ? { id } : {}), seq, role, contentJson: JSON.stringify({ role, content: [{ type: "text", text }] }) };
}

function setup(
  host: AgentSessionHost = fakeHost(),
  store: ArtifactStore = fakeStore(),
  options: Parameters<typeof createContainerApp>[3] = {},
) {
  const db = openDb(":memory:");
  const app = createContainerApp(db, host, store, options);
  const conversationId = crypto.randomUUID();
  const seed = (body: unknown) =>
    app.request(`/api/container/${conversationId}/seed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { db, app, conversationId, seed };
}

describe("container health", () => {
  it("responds ok and reports the baked image version (issue #56)", async () => {
    const { app } = setup(fakeHost(), fakeStore(), { imageVersion: "abc1234" });
    const response = await app.request("/api/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, version: "abc1234" });
  });

  it("reports version 'unknown' for an unbaked (test/local) build", async () => {
    const { app } = setup();
    expect(await (await app.request("/api/health")).json()).toEqual({ ok: true, version: "unknown" });
  });
});

describe("container seed", () => {
  it("creates the conversation under the caller's id and stores the rows verbatim", async () => {
    const { db, conversationId, seed } = setup();
    const response = await seed({ cadEnvironment: "build123d", rows: [seedRow(0, "user", "make a box", "m-0"), seedRow(1, "assistant", "done")] });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, appended: 2, maxSeq: 1 });

    expect(getConversation(db, conversationId)?.cadEnvironment).toBe("build123d");
    const rows = listMessages(db, conversationId);
    expect(rows.map((row) => [row.seq, row.role])).toEqual([[0, "user"], [1, "assistant"]]);
    expect(rows[0]?.id).toBe("m-0");
    expect(rows[0]?.contentJson).toContain("make a box");
  });

  it("re-seeding rows the scratch store already holds appends nothing", async () => {
    const { db, conversationId, seed } = setup();
    await seed({ rows: [seedRow(0, "user", "make a box")] });
    const response = await seed({ rows: [seedRow(0, "user", "make a box"), seedRow(1, "assistant", "done")] });
    expect(await response.json()).toEqual({ ok: true, appended: 1, maxSeq: 1 });
    expect(listMessages(db, conversationId)).toHaveLength(2);
  });

  it("an empty seed still creates the conversation so a first prompt can run", async () => {
    const { db, conversationId, seed } = setup();
    const response = await seed({});
    expect(await response.json()).toEqual({ ok: true, appended: 0, maxSeq: -1 });
    expect(getConversation(db, conversationId)).toBeDefined();
  });

  it("rejects the fusion environment: the hosted deployment has no Fusion", async () => {
    const { seed } = setup();
    const response = await seed({ cadEnvironment: "fusion" });
    expect(response.status).toBe(400);
  });

  it("rejects malformed rows without writing anything", async () => {
    const { db, conversationId, seed } = setup();
    for (const rows of [
      [{ seq: 0.5, role: "user", contentJson: "{}" }],
      [{ seq: 0, role: "", contentJson: "{}" }],
      [{ seq: 0, role: "user", contentJson: "not json" }],
      [{ seq: 0, role: "user", contentJson: "[1,2]" }],
      [seedRow(1, "user", "a"), seedRow(1, "user", "b")],
      [seedRow(2, "user", "a"), seedRow(1, "user", "b")],
    ]) {
      const response = await seed({ rows });
      expect(response.status).toBe(400);
    }
    expect(listMessages(db, conversationId)).toHaveLength(0);
  });

  it("409s new rows once a session went live in this process, but tolerates identical re-seeds", async () => {
    const { app, conversationId, seed } = setup();
    await seed({ rows: [seedRow(0, "user", "make a box")] });
    const prompt = await app.request(`/api/agent/${conversationId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "make it taller" }),
    });
    expect(prompt.status).toBe(202);

    const identical = await seed({ rows: [seedRow(0, "user", "make a box")] });
    expect(identical.status).toBe(200);
    expect(await identical.json()).toEqual({ ok: true, appended: 0, maxSeq: 0 });

    const conflicting = await seed({ rows: [seedRow(1, "assistant", "late arrival")] });
    expect(conflicting.status).toBe(409);
  });

  it("applies a per-turn LLM delivery through the seam before answering", async () => {
    const applied: Array<{ baseUrl: string; token: string }> = [];
    const { seed } = setup(fakeHost(), fakeStore(), {
      applyLlmDelivery: async (delivery) => {
        applied.push(delivery);
      },
    });
    const response = await seed({
      rows: [seedRow(0, "user", "make a box")],
      llm: { baseUrl: "https://app.example/api/llm/anthropic/conv-1", token: "turn-token" },
    });
    expect(response.status).toBe(200);
    expect(applied).toEqual([{ baseUrl: "https://app.example/api/llm/anthropic/conv-1", token: "turn-token" }]);
  });

  it("a mid-turn re-seed with no new rows still rotates the LLM delivery", async () => {
    const applied: string[] = [];
    const { app, conversationId, seed } = setup(fakeHost(), fakeStore(), {
      applyLlmDelivery: async (delivery) => {
        applied.push(delivery.token);
      },
    });
    await seed({ rows: [seedRow(0, "user", "make a box")], llm: { baseUrl: "https://p/1", token: "t1" } });
    const prompt = await app.request(`/api/agent/${conversationId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "go" }),
    });
    expect(prompt.status).toBe(202);
    const again = await seed({ rows: [seedRow(0, "user", "make a box")], llm: { baseUrl: "https://p/1", token: "t2" } });
    expect(again.status).toBe(200);
    expect(applied).toEqual(["t1", "t2"]);
  });

  it("rejects malformed LLM deliveries and refuses one without a configured seam", async () => {
    const withSeam = setup(fakeHost(), fakeStore(), { applyLlmDelivery: async () => {} });
    for (const llm of [null, "x", {}, { baseUrl: "https://p" }, { token: "t" }, { baseUrl: "", token: "t" }]) {
      expect((await withSeam.seed({ llm })).status).toBe(400);
    }
    const withoutSeam = setup();
    const response = await withoutSeam.seed({ llm: { baseUrl: "https://p", token: "t" } });
    expect(response.status).toBe(500);
  });

  it("accepts a delivered model with its provider and hands both to the seam (issue #53)", async () => {
    const applied: unknown[] = [];
    const { seed } = setup(fakeHost(), fakeStore(), {
      applyLlmDelivery: async (delivery) => {
        applied.push(delivery);
      },
    });
    const modelJson = JSON.stringify({ provider: "google", id: "gemini-test" });
    const response = await seed({
      llm: { baseUrl: "https://app.example/api/llm/google/conv-1", token: "t", modelJson, provider: "google" },
    });
    expect(response.status).toBe(200);
    expect(applied).toEqual([
      { baseUrl: "https://app.example/api/llm/google/conv-1", token: "t", modelJson, provider: "google" },
    ]);
  });

  it("rejects deliveries with unroutable or contradictory model routing", async () => {
    const { seed } = setup(fakeHost(), fakeStore(), { applyLlmDelivery: async () => {} });
    const base = { baseUrl: "https://p", token: "t" };
    for (const llm of [
      { ...base, provider: "mistral" },
      { ...base, modelJson: "not json" },
      { ...base, modelJson: JSON.stringify({ provider: "mistral", id: "m" }) },
      { ...base, provider: "google", modelJson: JSON.stringify({ provider: "openai", id: "g" }) },
      { ...base, modelJson: "" },
    ]) {
      expect((await seed({ llm })).status).toBe(400);
    }
  });

  it("a failed delivery fails the seed so the turn never starts on stale credentials", async () => {
    const { seed } = setup(fakeHost(), fakeStore(), {
      applyLlmDelivery: async () => {
        throw new Error("settings write failed");
      },
    });
    const response = await seed({ llm: { baseUrl: "https://p", token: "t" } });
    expect(response.status).toBe(500);
    expect(((await response.json()) as { error: string }).error).toMatch(/settings write failed/);
  });

  it("a failed prompt does not lock the conversation against seeding", async () => {
    const { app, conversationId, seed } = setup(fakeHost({
      prompt: async () => {
        throw new Error("model not configured");
      },
    }));
    await seed({});
    const prompt = await app.request(`/api/agent/${conversationId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hi" }),
    });
    expect(prompt.status).toBe(502);
    const response = await seed({ rows: [seedRow(0, "user", "hi")] });
    expect(response.status).toBe(200);
  });
});

describe("container transcript", () => {
  it("returns rows after a seq watermark with the current artifact revision", async () => {
    const { app, conversationId, seed } = setup(fakeHost(), fakeStore({
      current: async () => ({ revision: 4200, bytes: async () => new Uint8Array() }),
    }));
    await seed({ rows: [seedRow(0, "user", "make a box"), seedRow(1, "assistant", "built"), seedRow(2, "user", "taller")] });

    const all = await app.request(`/api/container/${conversationId}/transcript`);
    expect(all.status).toBe(200);
    const allBody = await all.json() as { rows: Array<{ seq: number }>; artifactRevision: number | null };
    expect(allBody.rows.map((row) => row.seq)).toEqual([0, 1, 2]);
    expect(allBody.artifactRevision).toBe(4200);

    const after = await app.request(`/api/container/${conversationId}/transcript?afterSeq=1`);
    const afterBody = await after.json() as { rows: Array<{ seq: number }> };
    expect(afterBody.rows.map((row) => row.seq)).toEqual([2]);
  });

  it("reports a null revision before the first export", async () => {
    const { app, conversationId, seed } = setup();
    await seed({});
    const response = await app.request(`/api/container/${conversationId}/transcript`);
    expect(await response.json()).toEqual({ rows: [], artifactRevision: null });
  });

  it("404s an unseeded conversation and 400s a bad watermark", async () => {
    const { app, conversationId, seed } = setup();
    expect((await app.request(`/api/container/${conversationId}/transcript`)).status).toBe(404);
    await seed({});
    expect((await app.request(`/api/container/${conversationId}/transcript?afterSeq=abc`)).status).toBe(400);
  });
});

describe("container status", () => {
  it("reports the session host's run state for any conversation id", async () => {
    const { app } = setup(fakeHost({ status: () => ({ running: true, startedAt: 123 }) }));
    const response = await app.request(`/api/container/${crypto.randomUUID()}/status`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ running: true, startedAt: 123 });
  });

  it("answers not-running for a conversation this container has never seen", async () => {
    const { app } = setup();
    const response = await app.request(`/api/container/${crypto.randomUUID()}/status`);
    expect(await response.json()).toEqual({ running: false });
  });
});

describe("agent surface", () => {
  it("mounts the standard agent routes against the seeded conversation", async () => {
    const events: string[] = [];
    const { app, conversationId, seed } = setup(fakeHost({
      prompt: async (id, text) => {
        events.push(`${id}:${text}`);
      },
    }));
    await seed({});
    const response = await app.request(`/api/agent/${conversationId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "make a box" }),
    });
    expect(response.status).toBe(202);
    expect(events).toEqual([`${conversationId}:make a box`]);
  });

  it("404s a prompt for a conversation that was never seeded", async () => {
    const { app, conversationId } = setup();
    const response = await app.request(`/api/agent/${conversationId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "make a box" }),
    });
    expect(response.status).toBe(404);
  });
});
