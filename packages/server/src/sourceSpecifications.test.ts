import { describe, expect, it } from "vitest";
import { openDb } from "./db";
import { createAttachment, createConversation, createMessage } from "./conversationStore";
import {
  listSourceSpecifications,
  recordSourceSpecifications,
  SourceSpecificationError,
} from "./sourceSpecifications";

function setup() {
  const db = openDb(":memory:");
  const conversation = createConversation(db, "Source specifications");
  const text = "Build a 30 x 30 x 6 mm base plate with a 30 x 30 x 4 mm lid resting on it.";
  createMessage(db, conversation.id, {
    id: "source-message",
    seq: 0,
    role: "user",
    contentJson: JSON.stringify({ role: "user", content: text, timestamp: 1 }),
  });
  const source = (quote: string) => {
    const start = text.indexOf(quote);
    return { messageId: "source-message", text: quote, start, end: start + quote.length };
  };
  const input = {
    specifications: [
      { id: "base-envelope", requirement: "The base plate must be 30 x 30 x 6 mm.", source: source("30 x 30 x 6 mm base plate") },
      { id: "lid-envelope", requirement: "The lid must be 30 x 30 x 4 mm.", source: source("30 x 30 x 4 mm lid") },
      { id: "lid-resting", requirement: "The lid must rest on the base plate.", source: source("lid resting on it") },
    ],
  };
  return { db, conversation, input };
}

describe("durable source specifications", () => {
  it("persists stable identities, exact provenance, actor, status, timestamp, and source ordering", () => {
    const { db, conversation, input } = setup();
    const records = recordSourceSpecifications(db, conversation.id, input, "mutation-1");

    expect(records.map((record) => record.id)).toEqual(["base-envelope", "lid-envelope", "lid-resting"]);
    expect(records.every((record) => record.conversationId === conversation.id)).toBe(true);
    expect(records.every((record) => record.actor === "agent" && record.status === "active")).toBe(true);
    expect(records.every((record) => Number.isInteger(record.timestamp))).toBe(true);
    expect(records.map((record) => "text" in record.source ? record.source.text : undefined)).toEqual([
      "30 x 30 x 6 mm base plate",
      "30 x 30 x 4 mm lid",
      "lid resting on it",
    ]);
    expect(listSourceSpecifications(db, conversation.id)).toEqual(records);
    expect(records[0]).not.toHaveProperty("checks");
    expect(records[0]).not.toHaveProperty("implementation");
  });

  it("replays an exact mutation, rejects conflicting key or identity reuse, and remains immutable", () => {
    const { db, conversation, input } = setup();
    const first = recordSourceSpecifications(db, conversation.id, input, "mutation-1");
    expect(recordSourceSpecifications(db, conversation.id, input, "mutation-1")).toEqual(first);
    expect(recordSourceSpecifications(db, conversation.id, input, "mutation-2")).toEqual(first);

    const conflicting = structuredClone(input);
    conflicting.specifications[0]!.requirement = "Use a different base.";
    expect(() => recordSourceSpecifications(db, conversation.id, conflicting, "mutation-1"))
      .toThrowError(/idempotency key conflicts/);
    expect(() => recordSourceSpecifications(db, conversation.id, conflicting, "mutation-3"))
      .toThrowError(/identity base-envelope conflicts/);
    expect(listSourceSpecifications(db, conversation.id)).toEqual(first);
  });

  it("enforces source-message ownership and exact persisted source text", () => {
    const { db, conversation, input } = setup();
    const other = createConversation(db, "Other");

    expect(() => recordSourceSpecifications(db, other.id, input, "other-mutation"))
      .toThrowError(/does not belong to this conversation/);

    const altered = structuredClone(input);
    altered.specifications[0]!.source.text = "30 x 30 x 7 mm base plate";
    altered.specifications[0]!.source.end = altered.specifications[0]!.source.start + altered.specifications[0]!.source.text.length;
    expect(() => recordSourceSpecifications(db, conversation.id, altered, "altered-mutation"))
      .toThrowError(/does not match the persisted message/);
  });

  it("scopes idempotency keys to their owning conversation", () => {
    const { db, conversation, input } = setup();
    recordSourceSpecifications(db, conversation.id, input, "shared-tool-call-id");
    const other = createConversation(db, "Other");
    createMessage(db, other.id, {
      id: "other-source-message",
      seq: 0,
      role: "user",
      contentJson: JSON.stringify({ role: "user", content: "Build a 12 mm cube.", timestamp: 1 }),
    });
    const otherInput = {
      specifications: [{
        id: "cube-size",
        requirement: "The cube must be 12 mm.",
        source: { messageId: "other-source-message", text: "12 mm cube", start: 8, end: 18 },
      }],
    };

    expect(recordSourceSpecifications(db, other.id, otherInput, "shared-tool-call-id"))
      .toMatchObject([{ conversationId: other.id, id: "cube-size" }]);
  });

  it("requires an idempotency key", () => {
    const { db, conversation, input } = setup();
    expect(() => recordSourceSpecifications(db, conversation.id, input, ""))
      .toThrowError(SourceSpecificationError);
  });

  it("records exact attachment evidence and preserves superseded provenance", () => {
    const { db, conversation } = setup();
    createAttachment(db, "source-message", "user-image", {
      mime: "image/png",
      contentHash: "a".repeat(64),
      byteSize: 10,
      blobPath: "images/aa/drawing.png",
    }, "drawing-ref");
    const firstInput = {
      specifications: [{
        id: "drawing-width-v1",
        requirement: "The body must be 30 mm wide.",
        source: {
          attachmentId: "drawing-ref",
          observation: "The original width callout reads 30 mm.",
          region: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
        },
      }],
    };
    const first = recordSourceSpecifications(db, conversation.id, firstInput, "reference-spec-1");
    expect(first).toMatchObject([{
      id: "drawing-width-v1",
      status: "active",
      source: {
        attachmentId: "drawing-ref",
        observation: "The original width callout reads 30 mm.",
        region: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
      },
    }]);
    expect(recordSourceSpecifications(db, conversation.id, firstInput, "reference-spec-1")).toEqual(first);

    const correction = recordSourceSpecifications(db, conversation.id, {
      specifications: [{
        id: "drawing-width-v2",
        requirement: "The body must be 32 mm wide.",
        source: {
          attachmentId: "drawing-ref",
          observation: "The corrected callout reads 32 mm.",
        },
        supersedesSpecificationId: "drawing-width-v1",
      }],
    }, "reference-spec-2");
    expect(correction).toMatchObject([{
      id: "drawing-width-v2",
      status: "active",
      supersedesSpecificationId: "drawing-width-v1",
    }]);
    expect(listSourceSpecifications(db, conversation.id)).toMatchObject([
      { id: "drawing-width-v1", status: "superseded", supersededBySpecificationId: "drawing-width-v2" },
      { id: "drawing-width-v2", status: "active", supersedesSpecificationId: "drawing-width-v1" },
    ]);
  });

  it("rejects cross-conversation attachments, invalid regions, and repeated supersession", () => {
    const { db, conversation } = setup();
    const other = createConversation(db, "Other reference owner");
    createMessage(db, other.id, { id: "other-message", seq: 0, role: "user", contentJson: "{}" });
    createAttachment(db, "other-message", "user-image", {
      mime: "image/png",
      contentHash: "b".repeat(64),
      byteSize: 10,
      blobPath: "images/bb/foreign.png",
    }, "foreign-ref");
    const foreignInput = {
      specifications: [{
        id: "foreign-width",
        requirement: "Honor the foreign width.",
        source: { attachmentId: "foreign-ref", observation: "Width is 10 mm." },
      }],
    };
    expect(() => recordSourceSpecifications(db, conversation.id, foreignInput, "foreign"))
      .toThrow(/does not belong to this conversation/);

    createAttachment(db, "source-message", "user-image", {
      mime: "image/png",
      contentHash: "c".repeat(64),
      byteSize: 10,
      blobPath: "images/cc/local.png",
    }, "local-ref");
    expect(() => recordSourceSpecifications(db, conversation.id, {
      specifications: [{
        id: "invalid-region",
        requirement: "Honor the marked feature.",
        source: {
          attachmentId: "local-ref",
          observation: "Marked feature.",
          region: { x: 0.9, y: 0, width: 0.2, height: 0.2 },
        },
      }],
    }, "invalid-region")).toThrow(/normalized 0..1/);

    recordSourceSpecifications(db, conversation.id, {
      specifications: [{
        id: "active-image-spec",
        requirement: "Honor the active image evidence.",
        source: { attachmentId: "local-ref", observation: "Original evidence." },
      }],
    }, "active-image-spec");
    recordSourceSpecifications(db, conversation.id, {
      specifications: [{
        id: "replacement-one",
        requirement: "Honor the first correction.",
        source: { attachmentId: "local-ref", observation: "First correction." },
        supersedesSpecificationId: "active-image-spec",
      }],
    }, "replacement-one");
    expect(() => recordSourceSpecifications(db, conversation.id, {
      specifications: [{
        id: "replacement-two",
        requirement: "Honor another correction.",
        source: { attachmentId: "local-ref", observation: "Second correction." },
        supersedesSpecificationId: "active-image-spec",
      }],
    }, "replacement-two")).toThrow(/already superseded/);
  });
});
