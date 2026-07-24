import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { initializeSchema } from "./db";
import {
  ConversationEventStore,
  migrateConversationEventLog,
  rebuildConversationProjection,
} from "./conversationEventStore";
import { ingestAgentRunEvents, getAgentRun } from "./agentRunLifecycle";

function fixture(): { db: DatabaseSync; store: ConversationEventStore } {
  const db = new DatabaseSync(":memory:");
  initializeSchema(db);
  return { db, store: new ConversationEventStore(db) };
}

describe("ConversationEventStore", () => {
  it("projects only events appended after its cached sequence", () => {
    const { store } = fixture();
    store.append("conversation-1", {
      type: "conversation.created",
      data: {
        title: "New chat",
        cadEnvironment: "build123d",
        designId: null,
        sourceSpecificationsRequired: true,
      },
    });
    for (let index = 0; index < 1_000; index += 1) {
      store.append("conversation-1", {
        type: "ui.state-updated",
        data: { key: `key-${index}`, value: index },
      });
    }
    const warmProjection = store.project("conversation-1");
    const events = vi.spyOn(store, "events");

    store.append("conversation-1", {
      type: "ui.state-updated",
      data: { key: "latest", value: true },
    });
    const projected = store.project("conversation-1");

    expect(events).toHaveBeenCalledWith("conversation-1", 1_001);
    expect(projected).toBe(warmProjection);
    expect(projected.lastSequence).toBe(1_002);
    expect(projected.uiState.latest).toBe(true);
  });

  it("bounds cached projections across many conversations", () => {
    const { store } = fixture();
    for (let index = 0; index < 33; index += 1) {
      const conversationId = `conversation-${index}`;
      store.append(conversationId, {
        type: "conversation.created",
        data: {
          title: `Conversation ${index}`,
          cadEnvironment: "build123d",
          designId: null,
          sourceSpecificationsRequired: true,
        },
      });
      store.project(conversationId);
    }
    const events = vi.spyOn(store, "events");

    store.project("conversation-0");

    expect(events).toHaveBeenCalledWith("conversation-0", 0);
  });

  it("builds the live projection only through appends and rebuilds it deterministically", () => {
    const { db, store } = fixture();
    store.append("conversation-1", {
      id: "created",
      recordedAt: 10,
      type: "conversation.created",
      data: {
        title: "New chat",
        cadEnvironment: "build123d",
        designId: null,
        sourceSpecificationsRequired: true,
      },
    });
    store.append("conversation-1", {
      id: "message",
      recordedAt: 20,
      type: "message.appended",
      data: {
        message: {
          id: "message-1",
          conversationId: "conversation-1",
          seq: 0,
          role: "user",
          contentJson: JSON.stringify({ role: "user", content: "Make a bracket" }),
          createdAt: 20,
        },
        attachments: [],
      },
    });
    store.append("conversation-1", {
      id: "ui",
      recordedAt: 30,
      type: "ui.state-updated",
      data: { key: "panel", value: "parameters" },
    });
    store.append("conversation-1", {
      id: "artifact",
      recordedAt: 40,
      type: "artifact.stored",
      data: {
        artifact: {
          id: "artifact-1",
          conversationId: "conversation-1",
          version: 1,
          pySource: "result = Box(10, 20, 30)",
          paramsJson: null,
          createdAt: 40,
        },
        evidenceIds: [],
      },
    });
    db.prepare(`INSERT INTO evidence_events
      (id, conversation_id, sequence, type, data_json, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run("verification-1", "conversation-1", 1, "artifact.verified", JSON.stringify({
        artifactId: "artifact-1",
        artifactVersion: 1,
        gate: { status: "passed", checks: [] },
        measurements: { volume: 6000 },
      }), 50);
    const liveArtifact = {
      gate_json: JSON.stringify({ status: "passed", checks: [] }),
      measurements_json: JSON.stringify({ volume: 6000 }),
    };
    db.prepare("UPDATE artifacts SET gate_json = ?, measurements_json = ? WHERE id = ?")
      .run(liveArtifact.gate_json, liveArtifact.measurements_json, "artifact-1");
    const agentRunId = "11111111-1111-4111-8111-111111111111";
    const configuration = {
      name: "current",
      identityHash: "a".repeat(64),
      provider: "openai",
      model: "gpt-5",
    };
    ingestAgentRunEvents(db, "conversation-1", agentRunId, [{
      version: 1,
      runId: agentRunId,
      seq: 0,
      timestamp: 60,
      type: "run.started",
      agentConfiguration: configuration,
    }, {
      version: 1,
      runId: agentRunId,
      seq: 1,
      timestamp: 70,
      type: "run.completed",
      outcome: "completed",
      durationMs: 10,
    }], "test");
    const liveAgentRun = getAgentRun(db, "conversation-1", agentRunId);
    db.prepare(`INSERT INTO agent_run_trace_refs (run_id, trace_id, observation_id)
      VALUES (?, 'trace-1', 'observation-1')`).run(agentRunId);
    db.prepare(`INSERT INTO agent_runs
      (id, conversation_id, status, started_at, release, agent_configuration_json, last_seq,
       counters_json, durations_json)
      VALUES ('spurious-agent', 'conversation-1', 'running', 1, 'stale', '{}', -1, '{}', '{}')`).run();

    const live = store.project("conversation-1");
    db.prepare("DELETE FROM agent_run_events WHERE run_id = ?").run(agentRunId);
    db.prepare("UPDATE agent_runs SET status = 'running', last_seq = -1 WHERE id = ?").run(agentRunId);
    rebuildConversationProjection(db, "conversation-1");
    const rebuilt = new ConversationEventStore(db).project("conversation-1");

    expect(rebuilt).toEqual(live);
    expect(db.prepare("SELECT content_json FROM messages WHERE id = ?").get("message-1"))
      .toMatchObject({ content_json: JSON.stringify({ role: "user", content: "Make a bracket" }) });
    expect(db.prepare("SELECT value_json FROM conversation_ui_projection WHERE conversation_id = ? AND key = ?")
      .get("conversation-1", "panel"))
      .toEqual({ value_json: JSON.stringify("parameters") });
    expect(db.prepare("SELECT gate_json, measurements_json FROM artifacts WHERE id = ?").get("artifact-1"))
      .toEqual(liveArtifact);
    expect(getAgentRun(db, "conversation-1", agentRunId)).toEqual(liveAgentRun);
    expect(db.prepare("SELECT trace_id FROM agent_run_trace_refs WHERE run_id = ?").get(agentRunId))
      .toEqual({ trace_id: "trace-1" });
    expect(getAgentRun(db, "conversation-1", "spurious-agent")).toBeUndefined();
  });

  it("stores evidence only as cross-log identities", () => {
    const { store } = fixture();
    store.append("conversation-1", {
      type: "conversation.created",
      data: {
        title: "New chat",
        cadEnvironment: "build123d",
        designId: null,
        sourceSpecificationsRequired: true,
      },
    });
    const event = store.append("conversation-1", {
      type: "evidence.linked",
      data: { evidenceId: "evidence-1", relationship: "verification" },
    });

    expect(JSON.stringify(event)).toContain("evidence-1");
    expect(JSON.stringify(event)).not.toContain("measurements");
    expect(JSON.stringify(event)).not.toContain("checks");
  });

  it("rejects events carrying bulk payloads instead of references", () => {
    const { store } = fixture();
    store.append("conversation-1", {
      type: "conversation.created",
      data: {
        title: "New chat",
        cadEnvironment: "build123d",
        designId: null,
        sourceSpecificationsRequired: true,
      },
    });

    expect(() => store.append("conversation-1", {
      type: "ui.state-updated",
      data: { key: "viewer", value: "x".repeat(1_100_000) },
    })).toThrow(/over the .*limit.*reference it by id/s);
  });

  it("rejects nested identities that disagree with the canonical stream", () => {
    const { store } = fixture();
    store.append("conversation-1", {
      type: "conversation.created",
      data: {
        title: "New chat",
        cadEnvironment: "build123d",
        designId: null,
        sourceSpecificationsRequired: true,
      },
    });
    expect(() => store.append("conversation-1", {
      type: "message.appended",
      data: {
        message: {
          id: "message-1",
          conversationId: "conversation-2",
          seq: 0,
          role: "user",
          contentJson: "{}",
          createdAt: 1,
        },
        attachments: [],
      },
    })).toThrow("message conversation identity does not match event stream");
    expect(store.events("conversation-1")).toHaveLength(1);
  });

  it("rolls back event and projection together through the Durable Object transaction seam", () => {
    const db = new DatabaseSync(":memory:");
    initializeSchema(db);
    const transactionSync = <T>(work: () => T): T => {
      db.exec("SAVEPOINT durable_object_transaction");
      try {
        const result = work();
        db.exec("RELEASE durable_object_transaction");
        return result;
      } catch (error) {
        db.exec("ROLLBACK TO durable_object_transaction");
        db.exec("RELEASE durable_object_transaction");
        throw error;
      }
    };
    (db as unknown as { transactionSync: typeof transactionSync }).transactionSync = transactionSync;
    const store = new ConversationEventStore(db);
    store.append("conversation-1", {
      type: "conversation.created",
      data: {
        title: "New chat",
        cadEnvironment: "build123d",
        designId: null,
        sourceSpecificationsRequired: true,
      },
    });
    const message = {
      id: "message-1",
      conversationId: "conversation-1",
      seq: 0,
      role: "user",
      contentJson: "{}",
      createdAt: 1,
    };
    store.append("conversation-1", { type: "message.appended", data: { message, attachments: [] } });
    const before = store.events("conversation-1");
    expect(() => store.append("conversation-1", {
      id: "must-roll-back",
      type: "message.appended",
      data: { message: { ...message, seq: 1 }, attachments: [] },
    })).toThrow(/UNIQUE constraint failed/);
    expect(store.events("conversation-1")).toEqual(before);
  });

  it("does not cache a projection observed inside a rolled-back outer transaction", () => {
    const { db, store } = fixture();
    store.append("conversation-1", {
      type: "conversation.created",
      data: {
        title: "Durable",
        cadEnvironment: "build123d",
        designId: null,
        sourceSpecificationsRequired: true,
      },
    });
    const durable = store.project("conversation-1");

    db.exec("BEGIN IMMEDIATE");
    store.append("conversation-1", {
      type: "ui.state-updated",
      data: { key: "phantom", value: true },
    });
    expect(store.project("conversation-1").uiState.phantom).toBe(true);
    db.exec("ROLLBACK");

    expect(store.project("conversation-1")).toBe(durable);
    expect(store.project("conversation-1").uiState.phantom).toBeUndefined();
  });

  it("synthesizes a replayable log for a legacy conversation with a terminal error", () => {
    const { db, store } = fixture();
    db.prepare(`INSERT INTO conversations
      (id, title, cad_environment, created_at, updated_at, source_specifications_required)
      VALUES ('legacy', 'Legacy run', 'build123d', 10, 30, 0)`).run();
    db.prepare(`INSERT INTO messages
      (id, conversation_id, seq, role, content_json, created_at)
      VALUES ('legacy-user', 'legacy', 0, 'user', ?, 20)`).run(
        JSON.stringify({ role: "user", content: "Build it", timestamp: 20 }),
      );
    db.prepare(`INSERT INTO messages
      (id, conversation_id, seq, role, content_json, created_at)
      VALUES ('legacy-error', 'legacy', 1, 'assistant', ?, 30)`).run(JSON.stringify({
        role: "assistant",
        content: [{ type: "text", text: "partial" }],
        stopReason: "error",
        errorMessage: "provider disconnected",
      timestamp: 30,
    }));
    db.prepare(`INSERT INTO attachments
      (id, message_id, kind, mime, content_hash, byte_size, blob_path, display_order)
      VALUES ('legacy-attachment', 'legacy-user', 'user-image', 'image/png', 'abcd', 4,
        'images/ab/abcd', 0)`).run();
    db.prepare(`INSERT INTO artifacts
      (id, conversation_id, version, py_source, params_json, created_at)
      VALUES ('legacy-artifact', 'legacy', 1, 'result = Box(1, 2, 3)', NULL, 35)`).run();
    db.prepare(`INSERT INTO evidence_events
      (id, conversation_id, sequence, type, data_json, recorded_at)
      VALUES ('legacy-plan', 'legacy', 1, 'plan.recorded', '{}', 15)`).run();

    const legacyMessages = db.prepare(`SELECT id, conversation_id AS conversationId, seq, role,
      content_json AS contentJson, created_at AS createdAt FROM messages
      WHERE conversation_id = 'legacy' ORDER BY seq`).all();

    migrateConversationEventLog(db);
    const projection = store.project("legacy");

    expect(projection.conversation).toMatchObject({ id: "legacy", title: "Legacy run" });
    expect(projection.messages).toEqual(legacyMessages);
    expect(projection.attachments).toEqual([{
      id: "legacy-attachment",
      messageId: "legacy-user",
      kind: "user-image",
      mime: "image/png",
      contentHash: "abcd",
      byteSize: 4,
      blobPath: "images/ab/abcd",
      displayOrder: 0,
    }]);
    expect(projection.artifacts).toMatchObject([{
      id: "legacy-artifact",
      conversationId: "legacy",
      version: 1,
      pySource: "result = Box(1, 2, 3)",
    }]);
    expect(projection.evidenceLinks).toEqual([{ evidenceId: "legacy-plan", relationship: "plan" }]);
    expect(JSON.parse(projection.messages[1]!.contentJson)).toMatchObject({
      stopReason: "error",
      errorMessage: "provider disconnected",
    });
  });

  it("retries a legacy cutover cleanly after an interrupted insert", () => {
    const { db, store } = fixture();
    db.prepare(`INSERT INTO conversations
      (id, title, cad_environment, created_at, updated_at, source_specifications_required)
      VALUES ('retry-legacy', 'Retry legacy', 'build123d', 1, 2, 0)`).run();
    db.prepare(`INSERT INTO messages
      (id, conversation_id, seq, role, content_json, created_at)
      VALUES ('retry-message', 'retry-legacy', 0, 'user', '{}', 2)`).run();
    db.exec(`CREATE TRIGGER interrupt_conversation_cutover BEFORE INSERT ON conversation_events
      WHEN NEW.conversation_id = 'retry-legacy' AND NEW.sequence = 2
      BEGIN SELECT RAISE(ABORT, 'fixture interruption'); END`);

    expect(() => migrateConversationEventLog(db)).toThrow("fixture interruption");
    expect(store.events("retry-legacy")).toEqual([]);
    db.exec("DROP TRIGGER interrupt_conversation_cutover");
    migrateConversationEventLog(db);
    expect(store.project("retry-legacy").messages).toHaveLength(1);
  });
});
