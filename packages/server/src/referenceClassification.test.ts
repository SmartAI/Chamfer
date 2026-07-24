import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClassifyReferenceInput } from "@chamfer/shared";
import sharp from "sharp";
import { openDb } from "./db";
import { createAttachment, createConversation, createMessage } from "./conversationStore";
import {
  classifyReference,
  listReferenceRecords,
  listReferenceRecordsWithAvailability,
  ReferenceClassificationError,
} from "./referenceClassification";
import { AttachmentStore } from "./attachmentStore";
import { listSourceSpecifications, recordSourceSpecifications } from "./sourceSpecifications";

function fixture() {
  const db = openDb(":memory:");
  const conversation = createConversation(db, "references");
  const text = "Build the 30 mm part from these drawings.";
  createMessage(db, conversation.id, {
    id: "message-1",
    seq: 0,
    role: "user",
    contentJson: JSON.stringify({ role: "user", content: text, timestamp: 1 }),
  });
  createAttachment(db, "message-1", "user-image", {
    mime: "image/png",
    contentHash: "a".repeat(64),
    byteSize: 1,
    blobPath: "blobs/aa/a.png",
  }, "ref-a");
  createAttachment(db, "message-1", "user-image", {
    mime: "image/png",
    contentHash: "b".repeat(64),
    byteSize: 1,
    blobPath: "blobs/bb/b.png",
  }, "ref-b");
  recordSourceSpecifications(db, conversation.id, {
    specifications: [{
      id: "overall-size",
      requirement: "The part must be 30 mm.",
      source: { messageId: "message-1", text: "30 mm part", start: 10, end: 20 },
    }],
  }, "fixture-specification");
  return { db, conversation };
}

const base = {
  purpose: "Primary dimensioned drawing",
  relationships: [] as Array<{ type: "complements" | "superseded-by"; referenceId: string }>,
  rationale: "The drawing establishes the requested part geometry.",
  specificationIds: ["overall-size"],
};

describe("reference classification", () => {
  it("reports availability only for blobs that pass storage verification", async () => {
    const directory = mkdtempSync(join(tmpdir(), "chamfer-reference-availability-"));
    try {
      const db = openDb(":memory:");
      const conversation = createConversation(db, "availability");
      createMessage(db, conversation.id, { id: "availability-message", seq: 0, role: "user", contentJson: "{}" });
      const store = new AttachmentStore(directory);
      const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#2367a8" } }).png().toBuffer();
      const valid = await store.write(png, "image/png");
      createAttachment(db, "availability-message", "user-image", valid, "available-ref");
      createAttachment(db, "availability-message", "user-image", {
        mime: "image/png",
        contentHash: "b".repeat(64),
        byteSize: png.byteLength,
        blobPath: `images/bb/${"b".repeat(64)}`,
      }, "missing-ref");
      const otherPng = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#a8324a" } }).png().toBuffer();
      const corrupt = await store.write(otherPng, "image/png");
      createAttachment(db, "availability-message", "user-image", corrupt, "corrupt-ref");
      writeFileSync(join(directory, corrupt.blobPath), "corrupt");

      const records = await listReferenceRecordsWithAvailability(db, store, conversation.id);

      expect(Object.fromEntries(records.map((record) => [record.referenceId, record.attachmentAvailable]))).toEqual({
        "available-ref": true,
        "missing-ref": false,
        "corrupt-ref": false,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("removes the legacy classification table after migrating a legacy NOT NULL blob table", () => {
    const directory = mkdtempSync(join(tmpdir(), "chamfer-reference-migration-"));
    const path = join(directory, "legacy.db");
    try {
      const legacy = new DatabaseSync(path);
      legacy.exec(`
        CREATE TABLE conversations (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE TABLE messages (
          id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), seq INTEGER NOT NULL,
          role TEXT NOT NULL, content_json TEXT NOT NULL, created_at INTEGER NOT NULL,
          UNIQUE(conversation_id, seq)
        );
        CREATE TABLE attachments (
          id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES messages(id), kind TEXT NOT NULL,
          mime TEXT NOT NULL, data BLOB NOT NULL
        );
      `);
      legacy.close();

      const migrated = openDb(path);
      expect(migrated.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'reference_classifications'",
      ).get()).toBeUndefined();
      expect(migrated.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'evidence_events'",
      ).get()).toEqual({ 1: 1 });
      migrated.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("derives stable unclassified reference records from user-image attachments", () => {
    const { db, conversation } = fixture();

    expect(listReferenceRecords(db, conversation.id)).toEqual([
      expect.objectContaining({ referenceId: "ref-a", status: "unclassified", history: [] }),
      expect.objectContaining({ referenceId: "ref-b", status: "unclassified", history: [] }),
    ]);
  });

  it("appends reversible classifications and preserves actor and timestamp history", () => {
    const { db, conversation } = fixture();

    const first = classifyReference(db, conversation.id, {
      ...base,
      referenceId: "ref-a",
      status: "active",
    });
    const second = classifyReference(db, conversation.id, {
      ...base,
      referenceId: "ref-a",
      status: "superseded",
      relationships: [{ type: "superseded-by", referenceId: "ref-b" }],
      rationale: "The correction in ref-b replaces this orientation.",
    });
    const third = classifyReference(db, conversation.id, {
      ...base,
      referenceId: "ref-a",
      status: "active",
      rationale: "The original remains authoritative for its dimensions.",
    });

    expect(first.actor).toBe("agent");
    expect(first.timestamp).toBeTypeOf("number");
    expect(second.id).not.toBe(first.id);
    expect(third.id).not.toBe(second.id);
    expect(listReferenceRecords(db, conversation.id)[0]).toMatchObject({
      referenceId: "ref-a",
      status: "active",
      rationale: third.rationale,
      history: [first, second, third],
    });
  });

  it("replays an exact idempotency key without appending history and rejects changed reuse", () => {
    const { db, conversation } = fixture();
    const input = { ...base, referenceId: "ref-a", status: "active" as const };
    const first = classifyReference(db, conversation.id, input, "classify-call-1");
    expect(classifyReference(db, conversation.id, input, "classify-call-1")).toEqual(first);
    expect(listReferenceRecords(db, conversation.id)[0]?.history).toEqual([first]);
    expect(() => classifyReference(db, conversation.id, { ...input, rationale: "Changed." }, "classify-call-1"))
      .toThrow(/idempotency key conflicts/);
    expect(listReferenceRecords(db, conversation.id)[0]?.history).toEqual([first]);
  });

  it.each([
    ["unknown reference", "missing", []],
    ["invalid relationship target", "ref-a", [{ type: "complements", referenceId: "missing" }]],
  ])("rejects %s without appending history", (_label, referenceId, relationships) => {
    const { db, conversation } = fixture();

    expect(() => classifyReference(db, conversation.id, {
      ...base,
      referenceId,
      status: "active",
      relationships: relationships as typeof base.relationships,
    })).toThrow(ReferenceClassificationError);
    expect(listReferenceRecords(db, conversation.id).every((record) => record.history.length === 0)).toBe(true);
  });

  it("rejects cross-conversation references", () => {
    const { db, conversation } = fixture();
    const other = createConversation(db, "other");

    expect(() => classifyReference(db, other.id, {
      ...base,
      referenceId: "ref-a",
      status: "active",
    })).toThrow(/does not belong to this conversation/);
    expect(listReferenceRecords(db, conversation.id)[0]?.history).toHaveLength(0);
  });

  it("rejects supersession cycles without appending the invalid event", () => {
    const { db, conversation } = fixture();
    classifyReference(db, conversation.id, {
      ...base,
      referenceId: "ref-a",
      status: "superseded",
      relationships: [{ type: "superseded-by", referenceId: "ref-b" }],
    });

    expect(() => classifyReference(db, conversation.id, {
      ...base,
      referenceId: "ref-b",
      status: "superseded",
      relationships: [{ type: "superseded-by", referenceId: "ref-a" }],
    })).toThrow(/cycle/);
    expect(listReferenceRecords(db, conversation.id)[1]?.history).toHaveLength(0);
  });

  it("requires specification identities or an explicit reason none can be extracted", () => {
    const { db, conversation } = fixture();

    expect(() => classifyReference(db, conversation.id, {
      ...base,
      referenceId: "ref-a",
      status: "active",
      specificationIds: [],
    })).toThrow(/specificationIds or noSpecificationReason/);
  });

  it("rejects malformed structured fields as validation errors", () => {
    const { db, conversation } = fixture();

    expect(() => classifyReference(db, conversation.id, {
      ...base,
      referenceId: "ref-a",
      status: "active",
      specificationIds: undefined,
    } as unknown as ClassifyReferenceInput)).toThrow(ReferenceClassificationError);
    expect(listReferenceRecords(db, conversation.id)[0]?.history).toHaveLength(0);
  });

  it("rejects dangling, cross-conversation, and superseded specification identities", () => {
    const { db, conversation } = fixture();
    expect(() => classifyReference(db, conversation.id, {
      ...base,
      referenceId: "ref-a",
      status: "active",
      specificationIds: ["missing-specification"],
    })).toThrow(/does not exist/);

    const other = createConversation(db, "Foreign specification owner");
    const otherText = "Build a 12 mm cube.";
    createMessage(db, other.id, {
      id: "foreign-message",
      seq: 0,
      role: "user",
      contentJson: JSON.stringify({ role: "user", content: otherText, timestamp: 1 }),
    });
    recordSourceSpecifications(db, other.id, {
      specifications: [{
        id: "foreign-size",
        requirement: "The cube must be 12 mm.",
        source: { messageId: "foreign-message", text: "12 mm cube", start: 8, end: 18 },
      }],
    }, "foreign-specification");
    expect(() => classifyReference(db, conversation.id, {
      ...base,
      referenceId: "ref-a",
      status: "active",
      specificationIds: ["foreign-size"],
    })).toThrow(/does not exist/);

    recordSourceSpecifications(db, conversation.id, {
      specifications: [{
        id: "corrected-size",
        requirement: "The corrected size must be honored.",
        source: { attachmentId: "ref-b", observation: "Corrected size callout." },
        supersedesSpecificationId: "overall-size",
      }],
    }, "corrected-specification");
    expect(() => classifyReference(db, conversation.id, {
      ...base,
      referenceId: "ref-a",
      status: "active",
      specificationIds: ["overall-size"],
    })).toThrow(/is superseded/);
    expect(listReferenceRecords(db, conversation.id)[0]?.history).toHaveLength(0);
  });

  it("migrates legacy string links into durable identities without losing classification history", () => {
    const directory = mkdtempSync(join(tmpdir(), "chamfer-reference-link-migration-"));
    const path = join(directory, "legacy-links.db");
    try {
      const db = new DatabaseSync(path);
      db.exec(`
        CREATE TABLE conversations (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE TABLE messages (
          id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), seq INTEGER NOT NULL,
          role TEXT NOT NULL, content_json TEXT NOT NULL, created_at INTEGER NOT NULL,
          UNIQUE(conversation_id, seq)
        );
        CREATE TABLE attachments (
          id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES messages(id), kind TEXT NOT NULL,
          mime TEXT NOT NULL, data BLOB NOT NULL
        );
        CREATE TABLE reference_classifications (
          id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
          reference_id TEXT NOT NULL REFERENCES attachments(id), status TEXT NOT NULL, purpose TEXT NOT NULL,
          relationships_json TEXT NOT NULL, rationale TEXT NOT NULL, specification_links_json TEXT NOT NULL,
          no_specification_reason TEXT, actor TEXT NOT NULL, created_at INTEGER NOT NULL
        );
      `);
      const conversationId = "legacy-conversation";
      db.prepare("INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, 1, 1)")
        .run(conversationId, "Legacy links");
      db.prepare("INSERT INTO messages (id, conversation_id, seq, role, content_json, created_at) VALUES (?, ?, 0, 'user', '{}', 1)")
        .run("legacy-message", conversationId);
      db.prepare("INSERT INTO attachments (id, message_id, kind, mime, data) VALUES (?, ?, 'user-image', 'image/png', ?)")
        .run("legacy-ref", "legacy-message", Buffer.from([0]));
      db.prepare(`
        INSERT INTO reference_classifications
          (id, conversation_id, reference_id, status, purpose, relationships_json,
           rationale, specification_links_json, no_specification_reason, actor, created_at)
        VALUES (?, ?, ?, 'active', 'Legacy drawing', '[]', 'Legacy rationale', ?, NULL, 'agent', 10)
      `).run("legacy-classification", conversationId, "legacy-ref", JSON.stringify(["plan.spec_sheet.width"]));
      db.close();

      const migrated = openDb(path);
      const records = listReferenceRecords(migrated, conversationId);
      expect(records[0]).toMatchObject({
        specificationIds: ["plan.spec_sheet.width"],
        legacySpecificationLinks: ["plan.spec_sheet.width"],
        history: [{ id: "legacy-classification", legacySpecificationLinks: ["plan.spec_sheet.width"] }],
      });
      expect(listSourceSpecifications(migrated, conversationId)).toMatchObject([{
        id: "plan.spec_sheet.width",
        actor: "migration",
        status: "active",
        source: { attachmentId: "legacy-ref" },
      }]);
      migrated.close();

      const reopened = openDb(path);
      expect(listReferenceRecords(reopened, conversationId)[0]?.specificationIds)
        .toEqual(["plan.spec_sheet.width"]);
      expect(listSourceSpecifications(reopened, conversationId)).toHaveLength(1);
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
