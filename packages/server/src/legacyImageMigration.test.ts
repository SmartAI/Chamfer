import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AttachmentStore } from "./attachmentStore";
import { openDb } from "./db";
import { migrateLegacyImages } from "./legacyImageMigration";
import {
  ConversationEventStore,
  migrateConversationEventLog,
  refreshLegacyConversationEventLogs,
} from "./conversationEventStore";

const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const PNG_1X1 = Buffer.from(PNG_1X1_BASE64, "base64");
const PNG_HASH = "431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460";

const tempDirs: string[] = [];

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "chamfer-legacy-migration-"));
  tempDirs.push(dataDir);
  const db = openDb(join(dataDir, "chamfer.db"));
  db.prepare("INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('c1', 'Legacy', 1, 1)").run();
  return { dataDir, db, store: new AttachmentStore(dataDir) };
}

function insertMessage(
  db: ReturnType<typeof openDb>,
  id: string,
  content: unknown,
  role = "user",
  seq = 1,
) {
  db.prepare(
    "INSERT INTO messages (id, conversation_id, seq, role, content_json, created_at) VALUES (?, 'c1', ?, ?, ?, 1)",
  ).run(id, seq, role, JSON.stringify({ role, content, timestamp: 1 }));
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("legacy image startup migration", () => {
  it("durably migrates a paired SQLite blob and inline image before normalizing its message", async () => {
    const { dataDir, db, store } = fixture();
    insertMessage(db, "m1", [
      { type: "text", text: "before" },
      { type: "image", data: PNG_1X1_BASE64, mimeType: "image/png" },
      { type: "text", text: "after" },
    ]);
    db.prepare(
      "INSERT INTO attachments (id, message_id, kind, mime, data) VALUES ('a1', 'm1', 'user-image', 'image/png', ?)",
    ).run(PNG_1X1);
    migrateConversationEventLog(db);

    const report = await migrateLegacyImages(db, store);
    refreshLegacyConversationEventLogs(db);

    expect(report).toMatchObject({ migrated: 1, broken: 0, normalizedMessages: 1 });
    expect(readFileSync(join(dataDir, "images", "43", PNG_HASH))).toEqual(PNG_1X1);
    expect(db.prepare("PRAGMA table_info(attachments)").all()).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "data" })]),
    );
    expect(db.prepare("SELECT * FROM attachments WHERE id = 'a1'").get()).toMatchObject({
      id: "a1",
      content_hash: PNG_HASH,
      byte_size: 68,
      blob_path: `images/43/${PNG_HASH}`,
      display_order: 0,
      migration_state: "migrated",
      migration_error: null,
    });
    const row = db.prepare("SELECT content_json FROM messages WHERE id = 'm1'").get() as { content_json: string };
    expect(JSON.parse(row.content_json).content).toEqual([
      { type: "text", text: "before" },
      { type: "attachment-reference", attachmentId: "a1", kind: "user-image", mimeType: "image/png" },
      { type: "text", text: "after" },
    ]);
    const replayed = new ConversationEventStore(db).project("c1");
    expect(JSON.parse(replayed.messages[0]!.contentJson)).toEqual(JSON.parse(row.content_json));
    expect(replayed.attachments[0]).toMatchObject({
      id: "a1",
      contentHash: PNG_HASH,
      byteSize: 68,
      blobPath: `images/43/${PNG_HASH}`,
    });
    expect(JSON.stringify(replayed)).not.toContain(PNG_1X1_BASE64);
  });

  it("recovers missing logical rows, deduplicates payloads, preserves positions, and is idempotent", async () => {
    const { dataDir, db, store } = fixture();
    insertMessage(db, "m1", [
      { type: "image", data: PNG_1X1_BASE64, mimeType: "image/png" },
      { type: "text", text: "between" },
      { type: "image", data: PNG_1X1_BASE64, mimeType: "image/png" },
    ]);

    const first = await migrateLegacyImages(db, store);
    const second = await migrateLegacyImages(db, store);

    expect(first).toMatchObject({ migrated: 2, broken: 0, normalizedMessages: 1, alreadyComplete: false });
    expect(second).toEqual({
      migrated: 0,
      broken: 0,
      normalizedMessages: 0,
      diagnostics: [],
      alreadyComplete: true,
    });
    expect(readdirSync(join(dataDir, "images", "43"))).toEqual([PNG_HASH]);
    const attachments = db.prepare(
      "SELECT id, content_hash, display_order FROM attachments ORDER BY display_order",
    ).all() as Array<{ id: string; content_hash: string; display_order: number }>;
    expect(attachments).toHaveLength(2);
    expect(attachments.map((row) => [row.content_hash, row.display_order])).toEqual([
      [PNG_HASH, 0],
      [PNG_HASH, 1],
    ]);
    const message = db.prepare("SELECT content_json FROM messages WHERE id = 'm1'").get() as { content_json: string };
    expect(JSON.parse(message.content_json).content).toEqual([
      expect.objectContaining({ type: "attachment-reference", attachmentId: attachments[0]!.id }),
      { type: "text", text: "between" },
      expect.objectContaining({ type: "attachment-reference", attachmentId: attachments[1]!.id }),
    ]);
  });

  it("migrates a valid SQLite-only legacy blob without changing text-only message content", async () => {
    const { dataDir, db, store } = fixture();
    const originalContent = [{ type: "text", text: "the image was stored out of line" }];
    insertMessage(db, "m1", originalContent);
    db.prepare(
      "INSERT INTO attachments (id, message_id, kind, mime, data) VALUES ('a1', 'm1', 'user-image', 'image/png', ?)",
    ).run(PNG_1X1);

    const report = await migrateLegacyImages(db, store);

    expect(report).toMatchObject({ migrated: 1, broken: 0, normalizedMessages: 0 });
    expect(readFileSync(join(dataDir, "images", "43", PNG_HASH))).toEqual(PNG_1X1);
    expect(db.prepare("SELECT content_hash, migration_state FROM attachments WHERE id = 'a1'").get()).toEqual({
      content_hash: PNG_HASH,
      migration_state: "migrated",
    });
    const message = db.prepare("SELECT content_json FROM messages WHERE id = 'm1'").get() as { content_json: string };
    expect(JSON.parse(message.content_json).content).toEqual(originalContent);
  });

  it.each([
    {
      name: "invalid base64",
      code: "invalid-base64",
      inline: { type: "image", data: "not base64", mimeType: "image/png" },
      row: undefined,
    },
    {
      name: "unsupported media",
      code: "unsupported-media",
      inline: { type: "image", data: PNG_1X1_BASE64, mimeType: "image/tiff" },
      row: undefined,
    },
    {
      name: "conflicting duplicate bytes",
      code: "conflicting-bytes",
      inline: { type: "image", data: PNG_1X1_BASE64, mimeType: "image/png" },
      row: Buffer.from("different"),
    },
    {
      name: "conflicting duplicate media",
      code: "conflicting-media",
      inline: { type: "image", data: PNG_1X1_BASE64, mimeType: "image/jpeg" },
      row: PNG_1X1,
    },
  ])("keeps $name recoverable until a durable blob can be linked", async ({ code, inline, row }) => {
    const { db, store } = fixture();
    insertMessage(db, "m1", [{ type: "text", text: "before" }, inline]);
    if (row) {
      db.prepare(
        "INSERT INTO attachments (id, message_id, kind, mime, data) VALUES ('a1', 'm1', 'user-image', 'image/png', ?)",
      ).run(row);
    }

    const report = await migrateLegacyImages(db, store);

    expect(report).toMatchObject({ migrated: 0, broken: 1, normalizedMessages: 0, alreadyComplete: false });
    expect(report.diagnostics).toEqual([expect.objectContaining({ messageId: "m1", code })]);
    expect(db.prepare("SELECT migration_state, migration_error FROM attachments").get()).toEqual({
      migration_state: "broken",
      migration_error: code,
    });
    expect(db.prepare("SELECT code FROM image_migration_diagnostics").get()).toEqual({ code });
    expect(db.prepare("SELECT COUNT(*) AS count FROM image_migration_versions").get()).toEqual({ count: 0 });
    expect(db.prepare("PRAGMA table_info(attachments)").all()).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "data" })]),
    );
    if (row) {
      const stored = (db.prepare("SELECT data FROM attachments").get() as { data: Uint8Array }).data;
      expect(Buffer.from(stored)).toEqual(row);
    }
    const message = db.prepare("SELECT content_json FROM messages WHERE id = 'm1'").get() as { content_json: string };
    expect(JSON.parse(message.content_json).content).toEqual([
      { type: "text", text: "before" },
      inline,
    ]);

    const replay = await migrateLegacyImages(db, store);

    expect(replay).toMatchObject({ migrated: 0, broken: 1, normalizedMessages: 0, alreadyComplete: false });
    expect(db.prepare("SELECT COUNT(*) AS count FROM image_migration_diagnostics").get()).toEqual({ count: 1 });
    expect(JSON.parse((db.prepare("SELECT content_json FROM messages WHERE id = 'm1'").get() as {
      content_json: string;
    }).content_json).content).toEqual([{ type: "text", text: "before" }, inline]);
  });

  it("marks an attachment with no inline or SQLite source bytes as broken", async () => {
    const { db, store } = fixture();
    insertMessage(db, "m1", [{ type: "text", text: "image was uploaded separately" }]);
    db.prepare(
      "INSERT INTO attachments (id, message_id, kind, mime, data) VALUES ('a1', 'm1', 'user-image', 'image/png', NULL)",
    ).run();

    await migrateLegacyImages(db, store);

    expect(db.prepare("SELECT migration_state, migration_error FROM attachments WHERE id = 'a1'").get()).toEqual({
      migration_state: "broken",
      migration_error: "missing-source-bytes",
    });
  });

  it("replays a partially migrated message against the same broken attachment", async () => {
    const { db, store } = fixture();
    const unsupported = { type: "image", data: PNG_1X1_BASE64, mimeType: "image/tiff" };
    insertMessage(db, "m1", [
      { type: "image", data: PNG_1X1_BASE64, mimeType: "image/png" },
      unsupported,
    ]);
    db.prepare(
      `INSERT INTO attachments (id, message_id, kind, mime, data, display_order)
       VALUES ('a-valid', 'm1', 'user-image', 'image/png', ?, 0),
              ('a-broken', 'm1', 'user-image', 'image/tiff', ?, 1)`,
    ).run(PNG_1X1, PNG_1X1);

    const first = await migrateLegacyImages(db, store);
    const rows = db.prepare(
      "SELECT id, data, migration_state, migration_error FROM attachments ORDER BY display_order",
    ).all() as Array<{ id: string; data: Uint8Array | null; migration_state: string; migration_error: string | null }>;
    const firstMessage = JSON.parse((db.prepare("SELECT content_json FROM messages WHERE id = 'm1'").get() as {
      content_json: string;
    }).content_json).content;

    expect(first).toMatchObject({ migrated: 1, broken: 1, normalizedMessages: 1, alreadyComplete: false });
    expect(rows).toEqual([
      expect.objectContaining({ id: "a-valid", data: null, migration_state: "migrated", migration_error: null }),
      expect.objectContaining({ id: "a-broken", migration_state: "broken", migration_error: "unsupported-media" }),
    ]);
    expect(Buffer.from(rows[1]!.data!)).toEqual(PNG_1X1);
    expect(firstMessage).toEqual([
      expect.objectContaining({ type: "attachment-reference", attachmentId: rows[0]!.id }),
      unsupported,
    ]);

    const replay = await migrateLegacyImages(db, store);
    const replayMessage = JSON.parse((db.prepare("SELECT content_json FROM messages WHERE id = 'm1'").get() as {
      content_json: string;
    }).content_json).content;

    expect(replay).toMatchObject({ migrated: 0, broken: 1, normalizedMessages: 0, alreadyComplete: false });
    expect(replay.diagnostics).toEqual([
      expect.objectContaining({ attachmentId: rows[1]!.id, messageId: "m1", code: "unsupported-media" }),
    ]);
    expect(replayMessage).toEqual(firstMessage);
    expect(db.prepare("SELECT COUNT(*) AS count FROM image_migration_diagnostics").get()).toEqual({ count: 1 });
  });

  it("resumes after interruption between verified file persistence and metadata linking", async () => {
    const { dataDir, db, store } = fixture();
    insertMessage(db, "m1", [{ type: "image", data: PNG_1X1_BASE64, mimeType: "image/png" }]);
    db.prepare(
      "INSERT INTO attachments (id, message_id, kind, mime, data) VALUES ('a1', 'm1', 'user-image', 'image/png', ?)",
    ).run(PNG_1X1);

    await expect(
      migrateLegacyImages(db, store, {
        afterBlobVerified: () => {
          const message = db.prepare("SELECT content_json FROM messages WHERE id = 'm1'").get() as {
            content_json: string;
          };
          expect(JSON.parse(message.content_json).content[0].type).toBe("image");
          expect(db.prepare("SELECT migration_state FROM attachments WHERE id = 'a1'").get()).toEqual({
            migration_state: "pending",
          });
          throw new Error("injected interruption");
        },
      }),
    ).rejects.toThrow("injected interruption");
    expect(readFileSync(join(dataDir, "images", "43", PNG_HASH))).toEqual(PNG_1X1);
    expect(db.prepare("PRAGMA table_info(attachments)").all()).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "data" })]),
    );

    const replay = await migrateLegacyImages(db, store);

    expect(replay).toMatchObject({ migrated: 1, broken: 0, normalizedMessages: 1 });
    expect(readdirSync(join(dataDir, "images", "43"))).toEqual([PNG_HASH]);
    expect(db.prepare("SELECT migration_state FROM attachments WHERE id = 'a1'").get()).toEqual({
      migration_state: "migrated",
    });
  });
});
