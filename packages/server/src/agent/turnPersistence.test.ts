import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { openDb } from "../db";
import { createConversation, createMessage, listMessages } from "../conversationStore";
import {
  appendStoredMessages,
  MAX_TOOL_RESULT_JSON_CHARS,
  persistTurnTranscript,
  seedSessionFromStore,
} from "./turnPersistence";

function setup() {
  const db = openDb(":memory:");
  const conversation = createConversation(db, "New chat", "build123d");
  return { db, conversationId: conversation.id };
}

describe("appendStoredMessages", () => {
  it("appends messages with sequential seqs after existing rows", () => {
    const { db, conversationId } = setup();
    appendStoredMessages(db, conversationId, [{ role: "user", content: "make a box" }]);
    appendStoredMessages(db, conversationId, [
      { role: "assistant", content: [{ type: "text", text: "on it" }] },
      { role: "toolResult", toolCallId: "tc-1", toolName: "execute", content: [] },
    ]);
    const rows = listMessages(db, conversationId);
    expect(rows.map((row) => [row.seq, row.role])).toEqual([
      [0, "user"],
      [1, "assistant"],
      [2, "toolResult"],
    ]);
  });
});

describe("persistTurnTranscript", () => {
  it("consumes an eagerly persisted user row by content, ignoring pi's re-stamped timestamp", () => {
    const { db, conversationId } = setup();
    const content = [{ type: "text", text: "make a box" }];
    // The prompt path persists the user message before the run starts...
    appendStoredMessages(db, conversationId, [{ role: "user", content, timestamp: 100 }]);
    // ...and agent_end.messages re-carries it with pi's own timestamp.
    persistTurnTranscript(db, conversationId, [
      { role: "user", content, timestamp: 105 },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ], [JSON.stringify(content)]);
    const rows = listMessages(db, conversationId);
    expect(rows.map((row) => row.role)).toEqual(["user", "assistant"]);
  });

  it("stores user messages pi injected itself: only eager rows are deduped", () => {
    const { db, conversationId } = setup();
    persistTurnTranscript(db, conversationId, [
      { role: "user", content: [{ type: "text", text: "continue with the remaining checks" }], timestamp: 7 },
      { role: "assistant", content: [{ type: "text", text: "continuing" }] },
    ]);
    const rows = listMessages(db, conversationId);
    expect(rows.map((row) => row.role)).toEqual(["user", "assistant"]);
    expect(rows[0]?.contentJson).toContain("remaining checks");
  });

  it("consumes identical eager entries as a multiset, one match each", () => {
    const { db, conversationId } = setup();
    const content = [{ type: "text", text: "again" }];
    appendStoredMessages(db, conversationId, [
      { role: "user", content, timestamp: 1 },
      { role: "user", content, timestamp: 2 },
    ]);
    persistTurnTranscript(db, conversationId, [
      { role: "user", content, timestamp: 3 },
      { role: "user", content, timestamp: 4 },
      { role: "assistant", content: [{ type: "text", text: "twice" }] },
    ], [JSON.stringify(content), JSON.stringify(content)]);
    const rows = listMessages(db, conversationId);
    expect(rows.map((row) => row.role)).toEqual(["user", "user", "assistant"]);
  });

  it("stores follow-up runs after the first without duplicating either", () => {
    const { db, conversationId } = setup();
    persistTurnTranscript(db, conversationId, [
      { role: "assistant", content: [{ type: "text", text: "first run" }] },
    ]);
    persistTurnTranscript(db, conversationId, [
      { role: "assistant", content: [{ type: "text", text: "retry continuation" }] },
    ]);
    const rows = listMessages(db, conversationId);
    expect(rows).toHaveLength(2);
    expect(rows[1]?.contentJson).toContain("retry continuation");
  });

  it("truncates a pathological tool result but keeps its identity and gate", () => {
    const { db, conversationId } = setup();
    const hugeText = "measurement ".repeat(60_000);
    persistTurnTranscript(db, conversationId, [
      {
        role: "toolResult",
        toolCallId: "tc-9",
        toolName: "execute",
        isError: false,
        content: [{ type: "text", text: hugeText }],
        details: { gate: { status: "passed", checks: [] }, snapshot: hugeText },
      },
    ]);
    const [row] = listMessages(db, conversationId);
    expect(row?.role).toBe("toolResult");
    expect(row!.contentJson.length).toBeLessThan(MAX_TOOL_RESULT_JSON_CHARS);
    const parsed = JSON.parse(row!.contentJson) as {
      toolCallId?: string;
      truncated?: boolean;
      content?: Array<{ type: string; text: string }>;
      details?: { gate?: { status?: string }; snapshot?: string };
    };
    expect(parsed.toolCallId).toBe("tc-9");
    expect(parsed.truncated).toBe(true);
    expect(parsed.content?.[0]?.text).toContain("measurement");
    expect(parsed.content?.[0]?.text).toContain("truncated");
    expect(parsed.details?.gate?.status).toBe("passed");
    expect(parsed.details?.snapshot).toBeUndefined();
  });

  it("stores an in-cap tool result verbatim", () => {
    const { db, conversationId } = setup();
    const message = {
      role: "toolResult",
      toolCallId: "tc-2",
      toolName: "execute",
      content: [{ type: "text", text: "volume 6000 mm^3" }],
      details: { measurements: { bboxMm: [10, 20, 30] } },
    };
    persistTurnTranscript(db, conversationId, [message]);
    const [row] = listMessages(db, conversationId);
    expect(JSON.parse(row!.contentJson)).toEqual(message);
  });
});

describe("seedSessionFromStore", () => {
  it("rebuilds the stored transcript as the context a fresh pi session resumes from", () => {
    const { db, conversationId } = setup();
    const userMessage = { role: "user", content: [{ type: "text", text: "make a box" }], timestamp: 1 };
    const transcript = [
      userMessage,
      {
        role: "assistant",
        content: [
          { type: "text", text: "Building it now." },
          { type: "toolCall", id: "call-1", name: "execute", arguments: { code: "Box(10, 20, 30)" } },
        ],
        stopReason: "toolUse",
        timestamp: 2,
      },
      { role: "toolResult", toolCallId: "call-1", toolName: "execute", content: [{ type: "text", text: "ok" }], timestamp: 3 },
      { role: "assistant", content: [{ type: "text", text: "Done: a 10x20x30 box." }], stopReason: "stop", timestamp: 4 },
    ];
    // Write the turn the way production does: eager prompt row, then agent_end
    // consuming it by content identity.
    appendStoredMessages(db, conversationId, [userMessage]);
    persistTurnTranscript(db, conversationId, transcript, [JSON.stringify(userMessage.content)]);

    const manager = seedSessionFromStore(db, conversationId, () => SessionManager.inMemory());
    expect(manager.buildSessionContext().messages).toEqual(transcript);
  });

  it("seeds a truncated toolResult stub as-is, keeping its pairing and marker", () => {
    const { db, conversationId } = setup();
    persistTurnTranscript(db, conversationId, [{
      role: "toolResult",
      toolCallId: "tc-9",
      toolName: "execute",
      content: [{ type: "text", text: "measurement ".repeat(60_000) }],
    }]);
    const manager = seedSessionFromStore(db, conversationId, () => SessionManager.inMemory());
    const [message] = manager.buildSessionContext().messages;
    expect(message).toMatchObject({ role: "toolResult", toolCallId: "tc-9", truncated: true });
  });

  it("routes stored custom messages through pi's custom_message entry kind", () => {
    const { db, conversationId } = setup();
    persistTurnTranscript(db, conversationId, [
      { role: "custom", customType: "adapter-note", content: [{ type: "text", text: "hint" }], display: false, timestamp: 5 },
    ]);
    const manager = seedSessionFromStore(db, conversationId, () => SessionManager.inMemory());
    expect(manager.getEntries().map((entry) => entry.type)).toEqual(["custom_message"]);
    const [message] = manager.buildSessionContext().messages;
    expect(message).toMatchObject({ role: "custom", customType: "adapter-note", content: [{ type: "text", text: "hint" }] });
  });

  /** The three failure cases below share one posture: any row that fails to
   * parse or validate must yield a demonstrably unseeded manager (zero
   * entries, so no partial toolCall/toolResult pairing) and exactly one
   * warning, never a failed session creation. */
  it("degrades to an unseeded session when any stored row fails to parse", () => {
    const { db, conversationId } = setup();
    appendStoredMessages(db, conversationId, [{ role: "user", content: [{ type: "text", text: "make a box" }] }]);
    createMessage(db, conversationId, { id: crypto.randomUUID(), seq: 1, role: "assistant", contentJson: "{not json" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const manager = seedSessionFromStore(db, conversationId, () => SessionManager.inMemory());
      expect(manager.getEntries()).toEqual([]);
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });

  it("discards the partially seeded manager when a later row parses but is not a message object", () => {
    const { db, conversationId } = setup();
    appendStoredMessages(db, conversationId, [{ role: "user", content: [{ type: "text", text: "make a box" }] }]);
    // Valid JSON but structurally poisonous: appending it would blow up
    // buildSessionContext later, inside createAgentSession.
    createMessage(db, conversationId, { id: crypto.randomUUID(), seq: 1, role: "assistant", contentJson: "null" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const manager = seedSessionFromStore(db, conversationId, () => SessionManager.inMemory());
      expect(manager.getEntries()).toEqual([]);
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });

  it("discards the partially seeded manager on a malformed custom row", () => {
    const { db, conversationId } = setup();
    appendStoredMessages(db, conversationId, [{ role: "user", content: [{ type: "text", text: "make a box" }] }]);
    createMessage(db, conversationId, {
      id: crypto.randomUUID(),
      seq: 1,
      role: "custom",
      contentJson: JSON.stringify({ role: "custom", customType: 42, content: 7, display: "nope" }),
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const manager = seedSessionFromStore(db, conversationId, () => SessionManager.inMemory());
      expect(manager.getEntries()).toEqual([]);
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });
});
