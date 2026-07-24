import { describe, expect, it } from "vitest";
import type { AgentRunLifecycleBatch, AgentRunLifecycleDto, ConversationDto } from "@chamfer/shared";
import { createApp } from "../app";
import { openDb } from "../db";

const CONFIG = {
  name: "current",
  identityHash: "a".repeat(64),
  provider: "openai",
  model: "gpt-5",
};

async function createConversation(app: ReturnType<typeof createApp>, title = "Trace") {
  return (await (await app.request("/api/conversations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title, cadEnvironment: "build123d" }),
  })).json()) as ConversationDto;
}

function postEvents(
  app: ReturnType<typeof createApp>,
  conversationId: string,
  runId: string,
  events: AgentRunLifecycleBatch["events"],
) {
  return app.request(`/api/conversations/${conversationId}/agent-runs/${runId}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ version: 1, events }),
  });
}

describe("agent-run lifecycle routes", () => {
  it("ingests one complete ordered run and exposes structured operational totals", async () => {
    const app = createApp(openDb(":memory:"), undefined, { release: "v0.2.2" });
    const conversation = await createConversation(app);
    const runId = "11111111-1111-4111-8111-111111111111";
    const response = await postEvents(app, conversation.id, runId, [
      {
        version: 1,
        runId,
        seq: 0,
        timestamp: 1_000,
        type: "run.started",
        agentConfiguration: CONFIG,
        evaluation: { caseExecutionId: "precise-box-1", caseId: "precise-box", corpusVersion: "1.0.0", repetition: 1 },
      },
      { version: 1, runId, seq: 1, timestamp: 1_010, type: "turn.started", operationId: "turn-1" },
      { version: 1, runId, seq: 2, timestamp: 1_020, type: "tool.started", operationId: "tool-1", name: "lookup_docs" },
      { version: 1, runId, seq: 3, timestamp: 1_050, type: "tool.completed", operationId: "tool-1", outcome: "ok", durationMs: 30 },
      { version: 1, runId, seq: 4, timestamp: 1_060, type: "tool.started", operationId: "cad-1", name: "execute_cad_change" },
      { version: 1, runId, seq: 5, timestamp: 1_160, type: "tool.completed", operationId: "cad-1", outcome: "ok", durationMs: 100 },
      { version: 1, runId, seq: 6, timestamp: 1_170, type: "retry.recorded", attempt: 1, delayMs: 250 },
      { version: 1, runId, seq: 7, timestamp: 1_200, type: "turn.completed", operationId: "turn-1", outcome: "ok", durationMs: 190 },
      { version: 1, runId, seq: 8, timestamp: 1_210, type: "persistence.failed", operationId: "message-1", durationMs: 10 },
      { version: 1, runId, seq: 9, timestamp: 1_220, type: "run.completed", outcome: "completed", durationMs: 220 },
    ]);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: runId,
      conversationId: conversation.id,
      status: "completed",
      outcome: "completed",
      release: "v0.2.2",
      evaluation: { caseExecutionId: "precise-box-1", caseId: "precise-box", corpusVersion: "1.0.0", repetition: 1 },
      lastSeq: 9,
      counters: {
        modelCalls: 1,
        toolCalls: 2,
        cadRuns: 1,
        retries: 1,
        compactions: 0,
        persistenceFailures: 1,
        searches: 1,
        skillLoads: 0,
      },
      durations: {
        modelMs: 190,
        toolMs: 130,
        cadMs: 100,
        compactionMs: 0,
        persistenceMs: 10,
        retryDelayMs: 250,
      },
    } satisfies Partial<AgentRunLifecycleDto>);

    const latest = await app.request(`/api/conversations/${conversation.id}/agent-runs/latest`);
    expect(latest.status).toBe(200);
    expect((await latest.json() as AgentRunLifecycleDto).id).toBe(runId);

    const conversationEvents = await app.request(`/api/conversations/${conversation.id}/conversation-state`);
    const state = await conversationEvents.json() as {
      agentRunEvents: AgentRunLifecycleBatch["events"];
    };
    expect(state.agentRunEvents.find((event) => event.type === "tool.started" && event.operationId === "cad-1"))
      .toMatchObject({ name: "execute_cad_change" });
  });

  it("records both legacy CAD aliases as the canonical conversation operation", async () => {
    const app = createApp(openDb(":memory:"));
    const conversation = await createConversation(app, "Legacy Fusion trace");
    const runId = "66666666-6666-4666-8666-666666666666";
    const response = await postEvents(app, conversation.id, runId, [
      { version: 1, runId, seq: 0, timestamp: 1_000, type: "run.started", agentConfiguration: CONFIG },
      { version: 1, runId, seq: 1, timestamp: 1_001, type: "tool.started", operationId: "cad-1", name: "execute_cad_change" },
      { version: 1, runId, seq: 2, timestamp: 1_002, type: "tool.completed", operationId: "cad-1", outcome: "ok", durationMs: 1 },
      { version: 1, runId, seq: 3, timestamp: 1_003, type: "run.completed", outcome: "completed", durationMs: 3 },
    ]);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      counters: { cadRuns: 1 },
      durations: { cadMs: 1 },
    });
    const state = await (await app.request(`/api/conversations/${conversation.id}/conversation-state`)).json() as {
      agentRunEvents: AgentRunLifecycleBatch["events"];
    };
    expect(state.agentRunEvents.find((event) => event.type === "tool.started"))
      .toMatchObject({ name: "execute_cad_change" });
  });

  it("accepts exact retries but rejects gaps, conflicting retries, and completed-run overwrite", async () => {
    const app = createApp(openDb(":memory:"));
    const conversation = await createConversation(app);
    const runId = "22222222-2222-4222-8222-222222222222";
    const started = {
      version: 1 as const,
      runId,
      seq: 0,
      timestamp: 1_000,
      type: "run.started" as const,
      agentConfiguration: CONFIG,
    };
    expect((await postEvents(app, conversation.id, runId, [started])).status).toBe(200);
    expect((await postEvents(app, conversation.id, runId, [started])).status).toBe(200);

    const gap = await postEvents(app, conversation.id, runId, [
      { version: 1, runId, seq: 2, timestamp: 1_002, type: "turn.started", operationId: "turn-1" },
    ]);
    expect(gap.status).toBe(409);

    const conflict = await postEvents(app, conversation.id, runId, [{ ...started, timestamp: 1_001 }]);
    expect(conflict.status).toBe(409);

    const completed = { version: 1 as const, runId, seq: 1, timestamp: 1_010, type: "run.completed" as const, outcome: "failed" as const, durationMs: 10 };
    expect((await postEvents(app, conversation.id, runId, [completed])).status).toBe(200);
    expect((await postEvents(app, conversation.id, runId, [completed])).status).toBe(200);
    const overwrite = await postEvents(app, conversation.id, runId, [
      { version: 1, runId, seq: 2, timestamp: 1_011, type: "retry.recorded", attempt: 1, delayMs: 1 },
    ]);
    expect(overwrite.status).toBe(409);
  });

  it("binds a run to its owning conversation and rejects arbitrary lifecycle content", async () => {
    const app = createApp(openDb(":memory:"));
    const owner = await createConversation(app, "Owner");
    const foreign = await createConversation(app, "Foreign");
    const runId = "33333333-3333-4333-8333-333333333333";
    const started = {
      version: 1 as const,
      runId,
      seq: 0,
      timestamp: 1_000,
      type: "run.started" as const,
      agentConfiguration: CONFIG,
    };
    expect((await postEvents(app, owner.id, runId, [started])).status).toBe(200);
    const stolen = await postEvents(app, foreign.id, runId, [
      { version: 1, runId, seq: 1, timestamp: 1_001, type: "run.completed", outcome: "completed", durationMs: 1 },
    ]);
    expect(stolen.status).toBe(409);

    const malformedId = "44444444-4444-4444-8444-444444444444";
    const malformed = await app.request(`/api/conversations/${owner.id}/agent-runs/${malformedId}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        events: [{
          version: 1,
          runId: malformedId,
          seq: 0,
          timestamp: 1_000,
          type: "run.started",
          agentConfiguration: CONFIG,
          prompt: "private prompt that must never be accepted",
        }],
      }),
    });
    expect(malformed.status).toBe(400);
  });

  it("rejects operation completions that are missing or mismatch their starts", async () => {
    const app = createApp(openDb(":memory:"));
    const conversation = await createConversation(app);
    const runId = "55555555-5555-4555-8555-555555555555";
    const response = await postEvents(app, conversation.id, runId, [
      { version: 1, runId, seq: 0, timestamp: 1_000, type: "run.started", agentConfiguration: CONFIG },
      { version: 1, runId, seq: 1, timestamp: 1_001, type: "tool.completed", operationId: "tool-1", outcome: "ok", durationMs: 1 },
    ]);
    expect(response.status).toBe(409);
    expect((await app.request(`/api/conversations/${conversation.id}/agent-runs/latest`)).status).toBe(404);
  });
});
