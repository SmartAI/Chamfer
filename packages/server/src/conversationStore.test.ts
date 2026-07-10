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
  it("is absent on a fresh conversation", () => {
    const db = openDb(":memory:");
    const convo = createConversation(db, "New chat");
    expect(getConversation(db, convo.id)?.lastGateStatus).toBeUndefined();
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
  it("adds the column to a pre-existing database without it", () => {
    const db = openDb(":memory:");
    // Simulate a pre-migration DB: drop and recreate conversations without the column.
    db.exec("DROP TABLE conversations");
    db.exec(`CREATE TABLE conversations (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`);
    expect(() => {
      migrateDb(db);
      migrateDb(db); // idempotent
    }).not.toThrow();
    const cols = db.prepare("PRAGMA table_info(conversations)").all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain("last_gate_status");
  });
});
