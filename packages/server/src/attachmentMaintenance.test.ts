import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AttachmentDto, ConversationDto, MessageDto } from "@chamfer/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app";
import { AttachmentStore } from "./attachmentStore";
import { getAttachment } from "./conversationStore";
import { openDb } from "./db";
import { runAttachmentMaintenance } from "./attachmentMaintenance";
import { prepareImageStorage } from "./startupImageStorage";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

const dirs: string[] = [];

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "chamfer-maintenance-"));
  dirs.push(dataDir);
  const db = openDb(join(dataDir, "chamfer.db"));
  const app = createApp(db, undefined, { dataDir });
  return { app, dataDir, db };
}

async function addAttachment(app: ReturnType<typeof createApp>, title: string, attachmentId: string) {
  const conversation = await (await app.request("/api/conversations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title, cadEnvironment: "build123d" }),
  })).json() as ConversationDto;
  const message = await (await app.request(`/api/conversations/${conversation.id}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: `${attachmentId}-message`, seq: 1, role: "user", contentJson: "{}" }),
  })).json() as MessageDto;
  const attachment = await (await app.request(
    `/api/messages/${message.id}/attachments?id=${attachmentId}&kind=user-image&mime=image/png`,
    { method: "POST", body: PNG },
  )).json() as AttachmentDto;
  return { conversation, message, attachment };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("image blob garbage collection", () => {
  it("deletes conversation evidence transactionally while retaining a hash referenced by another conversation", async () => {
    const { app, dataDir, db } = fixture();
    await prepareImageStorage(db, dataDir);
    const first = await addAttachment(app, "first", "first-image");
    const second = await addAttachment(app, "second", "second-image");
    db.prepare(
      `INSERT INTO reference_classifications
        (id, conversation_id, reference_id, status, purpose, relationships_json, rationale,
         specification_links_json, no_specification_reason, actor, created_at)
       VALUES ('classification-1', ?, ?, 'classified', 'geometry', '[]', 'relevant', '[]', NULL, 'agent', 1)`,
    ).run(first.conversation.id, first.attachment.id);
    db.prepare(
      `INSERT INTO inspection_leases
        (id, conversation_id, purpose, status, opened_at, closed_at)
       VALUES ('lease-1', ?, 'inspect', 'closed', 1, 2)`,
    ).run(first.conversation.id);
    db.prepare(
      "INSERT INTO inspection_lease_evidence (lease_id, attachment_id, display_order) VALUES ('lease-1', ?, 0)",
    ).run(first.attachment.id);
    db.prepare(
      `INSERT INTO inspection_observations
        (id, lease_id, relevant_views_json, facts_json, affected_specifications_json,
         affected_components_json, no_affected_entity_reason, recorded_at)
       VALUES ('observation-1', 'lease-1', '[]', '[]', '[]', '[]', NULL, 2)`,
    ).run();
    db.prepare(
      `INSERT INTO image_migration_diagnostics (attachment_id, message_id, code, created_at)
       VALUES (?, ?, 'recoverable', 1)`,
    ).run(first.attachment.id, first.message.id);
    db.prepare("INSERT INTO artifacts (id, conversation_id, version, py_source, created_at) VALUES ('artifact-delete', ?, 1, 'box', 1)")
      .run(first.conversation.id);
    db.prepare(`INSERT INTO visual_verifications
      (id, conversation_id, artifact_id, artifact_version, inspection_sheet_id,
       covered_reference_ids_json, verdict, observations_json, recorded_at)
      VALUES ('visual-delete', ?, 'artifact-delete', 1, ?, '[]', 'match', '[]', 1)`)
      .run(first.conversation.id, first.attachment.id);
    const blob = join(dataDir, "images", "43", first.attachment.contentHash);

    const response = await app.request(`/api/conversations/${first.conversation.id}`, { method: "DELETE" });

    expect(response.status).toBe(200);
    expect(db.prepare("SELECT id FROM attachments WHERE id = ?").get(first.attachment.id)).toBeUndefined();
    expect(db.prepare("SELECT id FROM inspection_leases WHERE id = 'lease-1'").get()).toBeUndefined();
    expect(db.prepare("SELECT * FROM inspection_lease_evidence WHERE lease_id = 'lease-1'").get()).toBeUndefined();
    expect(db.prepare("SELECT id FROM inspection_observations WHERE id = 'observation-1'").get()).toBeUndefined();
    expect(db.prepare("SELECT id FROM reference_classifications WHERE id = 'classification-1'").get()).toBeUndefined();
    expect(db.prepare("SELECT id FROM visual_verifications WHERE id = 'visual-delete'").get()).toBeUndefined();
    expect(db.prepare("SELECT code FROM image_migration_diagnostics WHERE attachment_id = ?").get(first.attachment.id))
      .toBeUndefined();
    expect(existsSync(blob)).toBe(true);
    const retrieval = await app.request(`/api/attachments/${second.attachment.id}`);
    expect(Buffer.from(await retrieval.arrayBuffer())).toEqual(PNG);

    await app.request(`/api/conversations/${second.conversation.id}`, { method: "DELETE" });
    expect(existsSync(blob)).toBe(false);
  });

  it("rolls back evidence and logical attachment deletion when any database delete fails", async () => {
    const { app, dataDir, db } = fixture();
    const item = await addAttachment(app, "atomic", "atomic-image");
    db.prepare(
      "INSERT INTO inspection_leases (id, conversation_id, purpose, status, opened_at) VALUES ('lease-atomic', ?, 'inspect', 'open', 1)",
    ).run(item.conversation.id);
    db.prepare(
      "INSERT INTO inspection_lease_evidence (lease_id, attachment_id, display_order) VALUES ('lease-atomic', ?, 0)",
    ).run(item.attachment.id);
    db.prepare("INSERT INTO artifacts (id, conversation_id, version, py_source, created_at) VALUES ('artifact-atomic', ?, 1, 'box', 1)")
      .run(item.conversation.id);
    db.prepare(`INSERT INTO visual_verifications
      (id, conversation_id, artifact_id, artifact_version, inspection_sheet_id,
       covered_reference_ids_json, verdict, observations_json, recorded_at)
      VALUES ('visual-atomic', ?, 'artifact-atomic', 1, ?, '[]', 'match', '[]', 1)`)
      .run(item.conversation.id, item.attachment.id);
    db.exec(`CREATE TRIGGER reject_attachment_delete BEFORE DELETE ON attachments
      BEGIN SELECT RAISE(ABORT, 'injected delete failure'); END`);

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await app.request(`/api/conversations/${item.conversation.id}`, { method: "DELETE" });
    consoleError.mockRestore();

    expect(response.status).toBe(500);
    expect(db.prepare("SELECT id FROM conversations WHERE id = ?").get(item.conversation.id)).toBeDefined();
    expect(db.prepare("SELECT id FROM attachments WHERE id = ?").get(item.attachment.id)).toBeDefined();
    expect(db.prepare("SELECT id FROM inspection_leases WHERE id = 'lease-atomic'").get()).toBeDefined();
    expect(db.prepare("SELECT * FROM inspection_lease_evidence WHERE lease_id = 'lease-atomic'").get()).toBeDefined();
    expect(db.prepare("SELECT id FROM visual_verifications WHERE id = 'visual-atomic'").get()).toBeDefined();
    expect(existsSync(join(dataDir, "images", "43", item.attachment.contentHash))).toBe(true);
  });

  it("sweeps expired partials and interrupted final writes while preserving every durable metadata reference", async () => {
    const { dataDir, db } = fixture();
    await prepareImageStorage(db, dataDir);
    const store = new AttachmentStore(dataDir);
    const referenced = await store.write(PNG, "image/png");
    db.prepare("INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('c', 'c', 1, 1)").run();
    db.prepare("INSERT INTO messages (id, conversation_id, seq, role, content_json, created_at) VALUES ('m', 'c', 1, 'user', '{}', 1)").run();
    db.prepare(
      `INSERT INTO attachments
        (id, message_id, kind, mime, content_hash, byte_size, blob_path, display_order, migration_state, migration_error)
       VALUES ('broken', 'm', 'user-image', 'image/png', ?, ?, ?, 0, 'broken', 'recoverable')`,
    ).run(referenced.contentHash, referenced.byteSize, referenced.blobPath);
    const orphanBytes = Buffer.concat([PNG, Buffer.from("orphan")]);
    const orphanHash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const orphanPath = join(dataDir, "images", "aa", orphanHash);
    mkdirSync(dirname(orphanPath), { recursive: true });
    writeFileSync(orphanPath, orphanBytes);
    const partial = join(dataDir, "images", ".tmp", "interrupted.partial");
    writeFileSync(partial, PNG);
    utimesSync(partial, new Date(0), new Date(0));

    const report = runAttachmentMaintenance(db, store, { now: () => 86_400_000, temporaryMaxAgeMs: 1_000 });

    expect(report.metadataBefore).toEqual([{
      attachmentId: "broken",
      contentHash: referenced.contentHash,
      blobPath: referenced.blobPath,
    }]);
    expect(report.fileSystemBefore).toEqual(expect.arrayContaining([
      referenced.blobPath,
      `images/aa/${orphanHash}`,
      "images/.tmp/interrupted.partial",
    ]));
    expect(report.removed).toEqual(expect.arrayContaining([`images/aa/${orphanHash}`, "images/.tmp/interrupted.partial"]));
    expect(report.fileSystemAfter).toEqual([referenced.blobPath]);
    expect(readFileSync(join(dataDir, referenced.blobPath))).toEqual(PNG);
  });

  it("retrieves an attachment after moving the complete data directory", async () => {
    const { app, dataDir, db } = fixture();
    const { attachment } = await addAttachment(app, "portable", "portable-image");
    db.close();
    const movedDir = `${dataDir}-moved`;
    renameSync(dataDir, movedDir);
    dirs[dirs.indexOf(dataDir)] = movedDir;
    const movedDb = openDb(join(movedDir, "chamfer.db"));
    const metadata = getAttachment(movedDb, attachment.id);
    expect(metadata?.storage).toBe("blob");
    if (!metadata || metadata.storage !== "blob") throw new Error("missing moved metadata");

    expect(Buffer.from(await new AttachmentStore(movedDir).read(metadata))).toEqual(PNG);
    movedDb.close();
  });

  it("reports a failed removal and removes the same orphan on a later maintenance retry", () => {
    const { dataDir, db } = fixture();
    const orphan = join(dataDir, "images", "ff", "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");
    mkdirSync(dirname(orphan), { recursive: true });
    writeFileSync(orphan, PNG);
    const remove = vi.fn<typeof rmSync>().mockImplementationOnce(() => {
      throw new Error("busy");
    }).mockImplementation(rmSync);
    const store = new AttachmentStore(dataDir, { fileSystem: { remove } });

    expect(runAttachmentMaintenance(db, store).failed).toEqual(["images/ff/ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"]);
    expect(existsSync(orphan)).toBe(true);
    expect(runAttachmentMaintenance(db, store).removed).toEqual(["images/ff/ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"]);
    expect(existsSync(orphan)).toBe(false);
  });

  it("runs the orphan sweep through the startup image-storage coordinator", async () => {
    const { dataDir, db } = fixture();
    const orphan = join(dataDir, "images", "ee", "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");
    mkdirSync(dirname(orphan), { recursive: true });
    writeFileSync(orphan, PNG);

    const result = await prepareImageStorage(db, dataDir);

    expect(result.maintenance.removed).toContain("images/ee/eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");
    expect(existsSync(orphan)).toBe(false);
  });
});
