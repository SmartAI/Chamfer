import { describe, expect, it } from "vitest";
import { migrateDb, openDb } from "./db";
import { createConversation, createMessage, getConversation, listConversations } from "./conversationStore";

function toolResultJson(gateStatus: string | undefined): string {
  const details: Record<string, unknown> = { measurements: { bboxMm: [1, 2, 3] } };
  if (gateStatus) {
    details.gate = {
      status: gateStatus,
      checks: [{ name: "bodies", passed: gateStatus === "passed", detail: "bodies: expected 1, found 1" }],
    };
  }
  return JSON.stringify({ role: "toolResult", toolCallId: "tc-1", content: [], details });
}

describe("lastGateStatus rollup", () => {
  it("persists an explicit Fusion environment in the conversation identity", () => {
    const db = openDb(":memory:");
    const conversation = createConversation(db, "Fusion design", "fusion");
    expect(conversation.cadEnvironment).toBe("fusion");
    expect(getConversation(db, conversation.id)?.cadEnvironment).toBe("fusion");
    expect(listConversations(db)[0]?.cadEnvironment).toBe("fusion");
  });

  it("is absent on a fresh conversation", () => {
    const db = openDb(":memory:");
    const convo = createConversation(db, "New chat");
    expect(getConversation(db, convo.id)?.lastGateStatus).toBeUndefined();
    expect(getConversation(db, convo.id)?.sourceSpecificationsRequired).toBe(true);
  });

  it("is set from a gate-bearing toolResult message", () => {
    const db = openDb(":memory:");
    const convo = createConversation(db, "New chat");
    createMessage(db, convo.id, { id: "m1", seq: 0, role: "toolResult", contentJson: toolResultJson("passed") });
    expect(getConversation(db, convo.id)?.lastGateStatus).toBe("passed");
    expect(listConversations(db)[0]?.lastGateStatus).toBe("passed");
  });

  it("tracks the most recent gate verdict", () => {
    const db = openDb(":memory:");
    const convo = createConversation(db, "New chat");
    createMessage(db, convo.id, { id: "m1", seq: 0, role: "toolResult", contentJson: toolResultJson("failed") });
    createMessage(db, convo.id, { id: "m2", seq: 1, role: "toolResult", contentJson: toolResultJson("passed") });
    expect(getConversation(db, convo.id)?.lastGateStatus).toBe("passed");
  });

  it("ignores non-toolResult roles and gate-less results", () => {
    const db = openDb(":memory:");
    const convo = createConversation(db, "New chat");
    createMessage(db, convo.id, { id: "m1", seq: 0, role: "user", contentJson: JSON.stringify({ role: "user", content: "hi" }) });
    createMessage(db, convo.id, { id: "m2", seq: 1, role: "toolResult", contentJson: toolResultJson(undefined) });
    expect(getConversation(db, convo.id)?.lastGateStatus).toBeUndefined();
  });

  it("keeps the previous verdict when a later result has no gate", () => {
    const db = openDb(":memory:");
    const convo = createConversation(db, "New chat");
    createMessage(db, convo.id, { id: "m1", seq: 0, role: "toolResult", contentJson: toolResultJson("failed") });
    createMessage(db, convo.id, { id: "m2", seq: 1, role: "toolResult", contentJson: toolResultJson(undefined) });
    expect(getConversation(db, convo.id)?.lastGateStatus).toBe("failed");
  });

  it("never blocks the insert on malformed or unexpected contentJson", () => {
    const db = openDb(":memory:");
    const convo = createConversation(db, "New chat");
    createMessage(db, convo.id, { id: "m1", seq: 0, role: "toolResult", contentJson: "not json {{" });
    createMessage(db, convo.id, { id: "m2", seq: 1, role: "toolResult", contentJson: JSON.stringify({ details: { gate: { status: "bogus-status" } } }) });
    expect(getConversation(db, convo.id)?.lastGateStatus).toBeUndefined();
    expect(listConversations(db)).toHaveLength(1);
  });
});

describe("last_gate_status migration", () => {
  it("migrates a pre-existing conversation to build123d without losing related data", () => {
    const db = openDb(":memory:");
    db.exec("DROP TABLE conversations");
    db.exec(`CREATE TABLE conversations (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    INSERT INTO conversations VALUES ('legacy-conversation', 'Legacy design', 1, 2);
    INSERT INTO messages (id, conversation_id, seq, role, content_json, created_at)
      VALUES ('legacy-message', 'legacy-conversation', 0, 'user', '{"role":"user","content":"Keep me"}', 1);
    INSERT INTO artifacts (id, conversation_id, version, py_source, params_json, created_at)
      VALUES ('legacy-artifact', 'legacy-conversation', 1, 'result = Box(1, 2, 3)', NULL, 1);
    `);
    db.prepare("INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('legacy', 'Legacy', 1, 1)").run();
    expect(() => {
      migrateDb(db);
      migrateDb(db); // idempotent
    }).not.toThrow();
    const cols = db.prepare("PRAGMA table_info(conversations)").all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain("last_gate_status");
    expect(cols.map((c) => c.name)).toContain("cad_environment");
    expect(getConversation(db, "legacy-conversation")).toMatchObject({
      title: "Legacy design",
      cadEnvironment: "build123d",
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?")
      .get("legacy-conversation")).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM artifacts WHERE conversation_id = ?")
      .get("legacy-conversation")).toEqual({ count: 1 });
    expect(cols.map((c) => c.name)).toContain("source_specifications_required");
    const legacy = db.prepare("SELECT source_specifications_required AS required FROM conversations WHERE id = 'legacy'").get() as
      { required: number };
    expect(legacy.required).toBe(0);
    const fresh = createConversation(db, "Fresh after migration");
    expect(fresh.sourceSpecificationsRequired).toBe(true);
  });
});
