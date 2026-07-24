import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../db";
import { createApp } from "../app";
import type { ConversationDto, MessageDto, AttachmentDto } from "@chamfer/shared";
import { appendFusionRecovery, currentFusionRecovery } from "../fusion/recoveryStore";

function makeApp() {
  return createApp(openDb(":memory:"));
}

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

const tempDirs: string[] = [];

function makePersistentApp(options?: Parameters<typeof createApp>[2]) {
  const dataDir = mkdtempSync(join(tmpdir(), "chamfer-attachments-"));
  tempDirs.push(dataDir);
  const db = openDb(join(dataDir, "chamfer.db"));
  return { app: createApp(db, undefined, { dataDir, ...options }), db, dataDir };
}

async function createMessageForAttachment(app: ReturnType<typeof createApp>, suffix = "1") {
  const conversation = (await (
    await app.request("/api/conversations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Images", cadEnvironment: "build123d" }),
    })
  ).json()) as ConversationDto;
  return (await (
    await app.request(`/api/conversations/${conversation.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: `image-message-${suffix}`, seq: 1, role: "user", contentJson: "{}" }),
    })
  ).json()) as MessageDto;
}

async function uploadPng(app: ReturnType<typeof createApp>, messageId: string) {
  return app.request(`/api/messages/${messageId}/attachments?kind=user-image&mime=image/png`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: PNG_1X1,
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("conversations routes", () => {
  it("requires a valid explicit CAD environment before creating a conversation", async () => {
    const app = makeApp();
    for (const body of [
      { title: "Missing environment" },
      { title: "Unknown environment", cadEnvironment: "other-cad" },
      { title: "", cadEnvironment: "build123d" },
    ]) {
      const response = await app.request("/api/conversations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
    }
    expect(await (await app.request("/api/conversations")).json()).toEqual([]);
  });

  it("supports the full conversation lifecycle", async () => {
    const { app, db } = makePersistentApp();

    // Create conversation
    const createRes = await app.request("/api/conversations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "My chat", cadEnvironment: "fusion" }),
    });
    expect(createRes.status).toBe(200);
    const conversation = (await createRes.json()) as ConversationDto;
    expect(conversation.id).toBeTruthy();
    expect(conversation.title).toBe("My chat");
    expect(conversation.cadEnvironment).toBe("fusion");
    expect(conversation.createdAt).toBeTypeOf("number");
    expect(conversation.updatedAt).toBeTypeOf("number");

    const getRes = await app.request(`/api/conversations/${conversation.id}`);
    expect(getRes.status).toBe(200);
    expect(await getRes.json()).toEqual(conversation);

    // Appears in listing
    const listRes = await app.request("/api/conversations");
    const list = (await listRes.json()) as ConversationDto[];
    expect(list.map((c) => c.id)).toContain(conversation.id);

    // Append two messages
    const msg1Content = JSON.stringify({ role: "user", content: "hi", timestamp: 1 });
    const msg1Res = await app.request(`/api/conversations/${conversation.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "m1", seq: 1, role: "user", contentJson: msg1Content }),
    });
    expect(msg1Res.status).toBe(200);
    const msg1 = (await msg1Res.json()) as MessageDto;
    expect(msg1.id).toBe("m1");
    expect(JSON.parse(msg1.contentJson)).toEqual(JSON.parse(msg1Content));

    const msg2Content = JSON.stringify({ role: "assistant", content: "hello", timestamp: 2 });
    const msg2Res = await app.request(`/api/conversations/${conversation.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "m2", seq: 2, role: "assistant", contentJson: msg2Content }),
    });
    expect(msg2Res.status).toBe(200);

    // Appending messages bumps updated_at
    const afterAppendList = (await (await app.request("/api/conversations")).json()) as ConversationDto[];
    const afterAppendConv = afterAppendList.find((c) => c.id === conversation.id);
    expect(afterAppendConv).toBeDefined();
    expect(afterAppendConv!.updatedAt).toBeGreaterThanOrEqual(conversation.createdAt);

    // List messages back in seq order, lossless contentJson
    const messagesRes = await app.request(`/api/conversations/${conversation.id}/messages`);
    expect(messagesRes.status).toBe(200);
    const messages = (await messagesRes.json()) as MessageDto[];
    expect(messages.map((m) => m.seq)).toEqual([1, 2]);
    expect(JSON.parse(messages.at(0)!.contentJson)).toEqual({ role: "user", content: "hi", timestamp: 1 });
    expect(JSON.parse(messages.at(1)!.contentJson)).toEqual({ role: "assistant", content: "hello", timestamp: 2 });

    // Upload an attachment
    const bytes = PNG_1X1;
    const attachRes = await app.request(
      `/api/messages/${msg1.id}/attachments?kind=user-image&mime=image/png`,
      {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: bytes,
      },
    );
    expect(attachRes.status).toBe(200);
    const attachment = (await attachRes.json()) as AttachmentDto;
    expect(attachment.id).toBeTruthy();
    expect(attachment.messageId).toBe(msg1.id);
    expect(attachment.kind).toBe("user-image");
    expect(attachment.mime).toBe("image/png");

    // Fetch it back byte-identical
    const fetchAttachRes = await app.request(`/api/attachments/${attachment.id}`);
    expect(fetchAttachRes.status).toBe(200);
    expect(fetchAttachRes.headers.get("content-type")).toBe("image/png");
    const fetchedBytes = new Uint8Array(await fetchAttachRes.arrayBuffer());
    expect(Buffer.from(fetchedBytes)).toEqual(bytes);

    // Delete conversation cascades
    const deleteRes = await app.request(`/api/conversations/${conversation.id}`, { method: "DELETE" });
    expect(deleteRes.status).toBe(200);

    const afterDeleteList = (await (await app.request("/api/conversations")).json()) as ConversationDto[];
    expect(afterDeleteList.map((c) => c.id)).not.toContain(conversation.id);

    const afterDeleteMessagesRes = await app.request(`/api/conversations/${conversation.id}/messages`);
    const afterDeleteMessages = (await afterDeleteMessagesRes.json()) as MessageDto[];
    expect(afterDeleteMessages).toEqual([]);

    const afterDeleteAttachRes = await app.request(`/api/attachments/${attachment.id}`);
    expect(afterDeleteAttachRes.status).toBe(404);
    expect(db.prepare("SELECT 1 FROM conversation_events WHERE conversation_id = ?").get(conversation.id))
      .toBeUndefined();
    expect(db.prepare("SELECT 1 FROM conversation_ui_projection WHERE conversation_id = ?").get(conversation.id))
      .toBeUndefined();
  });

  it("returns 409 with a structured error on duplicate (conversation_id, seq)", async () => {
    const app = makeApp();

    const createRes = await app.request("/api/conversations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Dup seq", cadEnvironment: "build123d" }),
    });
    const conversation = (await createRes.json()) as ConversationDto;

    const firstRes = await app.request(`/api/conversations/${conversation.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "m1", seq: 1, role: "user", contentJson: "{}" }),
    });
    expect(firstRes.status).toBe(200);

    const dupRes = await app.request(`/api/conversations/${conversation.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "m2", seq: 1, role: "user", contentJson: "{}" }),
    });
    expect(dupRes.status).toBe(409);
    expect(await dupRes.json()).toEqual({ error: "duplicate seq" });
  });

  it("deletes conversation-owned Fusion inspections while retaining immutable audit rows", async () => {
    const { app, db } = makePersistentApp();
    const conversation = await (await app.request("/api/conversations", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Fusion audit", cadEnvironment: "fusion" }),
    })).json() as ConversationDto;
    db.prepare(`INSERT INTO fusion_inspections
      (id, conversation_id, revision, snapshot_json, checks_json, screenshots_json, camera_restored, captured_at, stale_at)
      VALUES ('inspection-1', ?, 'rev-1', '{}', '[]', '[]', 1, 1, NULL)`).run(conversation.id);
    db.prepare(`INSERT INTO fusion_action_ledger
      (id, conversation_id, action_id, event, recorded_at, document_json, expected_revision, model_json, skills_json,
       policy_version, intent, body_sha256, affected_references_json, expected_effects_json, result_json, evidence_ids_json)
      VALUES ('ledger-1', ?, 'action-1', 'completed', 1, '{}', 'rev-0', '{}', '{}', 'v1', 'audit', 'hash', '[]', '[]', '{}', '[]')`).run(conversation.id);
    db.prepare(`INSERT INTO fusion_reconciliation_ledger
      (id, conversation_id, recorded_at, document_json, preceding_revision, observed_revision, status, reason,
       summary, changes_json, refreshed_references_json, refreshed_checks_json, evidence_id)
      VALUES ('reconciliation-1', ?, 1, '{}', 'rev-0', 'rev-1', 'reconciled', 'parameter-value-changed',
       'Width changed.', '[]', '[]', '[]', 'inspection-1')`).run(conversation.id);
    db.prepare(`INSERT INTO fusion_save_evidence
      (id, conversation_id, captured_at, preceding_document_json, resulting_document_json, revision, inspection_json)
      VALUES ('save-evidence-1', ?, 1, '{}', '{}', 'rev-1', '{}')`).run(conversation.id);
    const endpoint = "http://127.0.0.1:27182/mcp";
    appendFusionRecovery(db, {
      conversationId: conversation.id,
      endpoint,
      actionId: "action-1",
      state: "hard-recovery",
      failureClass: "disconnect",
      diagnosis: "Endpoint state is unresolved.",
      allowedOperation: "inspect-resulting-state",
      precedingRevision: "rev-0",
    }, 1);
    await app.request(`/api/conversations/${conversation.id}/ui-state/panel`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "inspection" }),
    });

    expect((await app.request(`/api/conversations/${conversation.id}`, { method: "DELETE" })).status).toBe(200);
    expect(currentFusionRecovery(db, endpoint)).toBeUndefined();
    expect(db.prepare("SELECT 1 FROM conversation_events WHERE conversation_id = ?").get(conversation.id)).toBeUndefined();
    expect(db.prepare("SELECT 1 FROM conversation_ui_projection WHERE conversation_id = ?").get(conversation.id))
      .toBeUndefined();
    expect(db.prepare("SELECT 1 FROM fusion_inspections WHERE conversation_id = ?").get(conversation.id)).toBeUndefined();
    expect(db.prepare("SELECT 1 FROM fusion_action_ledger WHERE conversation_id = ?").get(conversation.id)).toBeDefined();
    expect(db.prepare("SELECT 1 FROM fusion_reconciliation_ledger WHERE conversation_id = ?").get(conversation.id)).toBeDefined();
    expect(db.prepare("SELECT 1 FROM fusion_save_evidence WHERE conversation_id = ?").get(conversation.id)).toBeDefined();
  });

  it("returns 404 with a structured error when posting a message to a nonexistent conversation", async () => {
    const app = makeApp();

    const res = await app.request("/api/conversations/does-not-exist/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "m1", seq: 1, role: "user", contentJson: "{}" }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });

  it("returns 404 with a structured error when uploading an attachment to a nonexistent message", async () => {
    const app = makeApp();

    const res = await app.request("/api/messages/does-not-exist/attachments?kind=user-image&mime=image/png", {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: new Uint8Array([1, 2, 3]),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });

  it("returns 404 with a structured error on DELETE of a nonexistent conversation", async () => {
    const app = makeApp();

    const res = await app.request("/api/conversations/does-not-exist", { method: "DELETE" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });

  it("returns 400 with a structured error for an invalid attachment kind", async () => {
    const app = makeApp();

    const createRes = await app.request("/api/conversations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Bad kind", cadEnvironment: "build123d" }),
    });
    const conversation = (await createRes.json()) as ConversationDto;

    const msgRes = await app.request(`/api/conversations/${conversation.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "m1", seq: 1, role: "user", contentJson: "{}" }),
    });
    const msg = (await msgRes.json()) as MessageDto;

    const res = await app.request(`/api/messages/${msg.id}/attachments?kind=evil-kind&mime=image/png`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: new Uint8Array([1, 2, 3]),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid kind" });
  });
});

describe("content-addressed image attachments", () => {
  it("atomically stores normalized content and every attachment, and exactly replays a lost-response retry", async () => {
    const { app } = makePersistentApp();
    const conversation = (await (await app.request("/api/conversations", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Atomic", cadEnvironment: "build123d" }),
    })).json()) as ConversationDto;
    const normalized = {
      role: "user",
      content: [
        { type: "text", text: "two images" },
        { type: "attachment-reference", attachmentId: "first", kind: "user-image", mimeType: "image/png" },
        { type: "attachment-reference", attachmentId: "second", kind: "user-image", mimeType: "image/png" },
      ],
      timestamp: 1,
    };
    const request = {
      message: { id: "atomic-message", seq: 0, role: "user", contentJson: JSON.stringify(normalized) },
      attachments: ["first", "second"].map((id) => ({
        id, kind: "user-image", mime: "image/png", data: PNG_1X1.toString("base64"),
      })),
    };
    const first = await app.request(`/api/conversations/${conversation.id}/messages-with-attachments`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    expect(first.status).toBe(200);
    const retry = await app.request(`/api/conversations/${conversation.id}/messages-with-attachments`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request),
    });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual(await first.clone().json());
    const reloaded = (await (await app.request(`/api/conversations/${conversation.id}/messages`)).json()) as MessageDto[];
    expect(reloaded).toHaveLength(1);
    expect(JSON.parse(reloaded[0]!.contentJson)).toEqual(normalized);
    expect(reloaded[0]!.contentJson).not.toContain(PNG_1X1.toString("base64"));
    expect(((await (await app.request("/api/messages/atomic-message/attachments")).json()) as AttachmentDto[])
      .map((attachment) => attachment.id)).toEqual(["first", "second"]);

    const conflictingRetry = await app.request(`/api/conversations/${conversation.id}/messages-with-attachments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...request,
        message: { ...request.message, contentJson: request.message.contentJson.replace("two images", "changed") },
      }),
    });
    expect(conflictingRetry.status).toBe(409);
  });

  it("atomically stores a read-only inspect_fusion result with a revision-bound view sheet", async () => {
    const { app } = makePersistentApp();
    const conversation = (await (await app.request("/api/conversations", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Fusion inspection", cadEnvironment: "fusion" }),
    })).json()) as ConversationDto;
    const normalized = {
      role: "toolResult",
      toolName: "inspect_fusion",
      content: [
        { type: "text", text: "# Bound Fusion inspection" },
        { type: "attachment-reference", attachmentId: "sheet-1", kind: "view-sheet", mimeType: "image/png" },
      ],
      details: {
        mutated: false,
        revision: "rev-1",
        inspectionId: "inspection-1",
        viewSheet: true,
        evaluatedChecks: [],
        bodyVolumesMm3: [],
        visualArtifact: {
          artifactId: "artifact-1",
          artifactVersion: 1,
          revision: "rev-1",
          inspectionSheet: { attachmentId: "sheet-1" },
        },
      },
      timestamp: 1,
    };
    const response = await app.request(`/api/conversations/${conversation.id}/messages-with-attachments`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: { id: "inspect-fusion-message", seq: 0, role: "toolResult", contentJson: JSON.stringify(normalized) },
        attachments: [{ id: "sheet-1", kind: "view-sheet", mime: "image/png", data: PNG_1X1.toString("base64") }],
      }),
    });
    expect(response.status).toBe(200);
    const reloaded = (await (await app.request(`/api/conversations/${conversation.id}/messages`)).json()) as MessageDto[];
    expect(reloaded).toHaveLength(1);
    expect(JSON.parse(reloaded[0]!.contentJson)).toEqual(normalized);
  });

  it("atomically stores a rendered CAD diagnostic that remains an errored tool result", async () => {
    const { app } = makePersistentApp();
    const conversation = (await (await app.request("/api/conversations", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Diagnostic", cadEnvironment: "build123d" }),
    })).json()) as ConversationDto;
    const inspectionSheet = {
      attachmentId: "diagnostic-sheet",
      code: { toolCallId: "diagnostic-run", artifactId: "artifact-8", artifactVersion: 8 },
      measurements: { bboxMm: [100, 80, 30], volumeMm3: 5500, areaMm2: 1000, children: [] },
      gate: { status: "passed", checks: [] },
    };
    const normalized = {
      role: "toolResult",
      toolCallId: "diagnostic-run",
      toolName: "execute_cad_change",
      content: [
        { type: "text", text: "Plan conformance: FAILED\n- planned check is missing" },
        { type: "attachment-reference", attachmentId: "diagnostic-sheet", kind: "view-sheet", mimeType: "image/png" },
      ],
      details: {
        code: inspectionSheet.code,
        measurements: inspectionSheet.measurements,
        gate: inspectionSheet.gate,
        inspectionSheet,
      },
      isError: true,
      timestamp: 1,
    };
    const request = {
      message: { id: "diagnostic-message", seq: 0, role: "toolResult", contentJson: JSON.stringify(normalized) },
      attachments: [{
        id: "diagnostic-sheet", kind: "view-sheet", mime: "image/png", data: PNG_1X1.toString("base64"),
      }],
    };

    const first = await app.request(`/api/conversations/${conversation.id}/messages-with-attachments`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request),
    });
    expect(first.status).toBe(200);
    const retry = await app.request(`/api/conversations/${conversation.id}/messages-with-attachments`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request),
    });
    expect(retry.status).toBe(200);

    const reloaded = (await (await app.request(`/api/conversations/${conversation.id}/messages`)).json()) as MessageDto[];
    expect(reloaded).toHaveLength(1);
    expect(JSON.parse(reloaded[0]!.contentJson)).toEqual(normalized);
    expect(((await (await app.request("/api/messages/diagnostic-message/attachments")).json()) as AttachmentDto[]))
      .toHaveLength(1);
  });

  it("rejects CAD diagnostics whose source identity or measurements are missing or malformed", async () => {
    const { app } = makePersistentApp();
    const conversation = (await (await app.request("/api/conversations", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Malformed diagnostic", cadEnvironment: "build123d" }),
    })).json()) as ConversationDto;
    const validCode = { toolCallId: "diagnostic-run", artifactId: "artifact-8", artifactVersion: 8 };
    const validMeasurements = { bboxMm: [100, 80, 30], volumeMm3: 5500, areaMm2: 1000, children: [] };
    const cases = [
      { name: "missing code", code: undefined, measurements: validMeasurements },
      { name: "missing measurements", code: validCode, measurements: undefined },
      { name: "malformed code", code: {}, measurements: validMeasurements },
      { name: "malformed measurements", code: validCode, measurements: { volumeMm3: 5500 } },
    ];

    for (const [index, malformed] of cases.entries()) {
      const attachmentId = `malformed-sheet-${index}`;
      const details = {
        ...(malformed.code === undefined ? {} : { code: malformed.code }),
        ...(malformed.measurements === undefined ? {} : { measurements: malformed.measurements }),
        inspectionSheet: {
          attachmentId,
          ...(malformed.code === undefined ? {} : { code: malformed.code }),
          ...(malformed.measurements === undefined ? {} : { measurements: malformed.measurements }),
        },
      };
      const normalized = {
        role: "toolResult",
        toolCallId: `malformed-run-${index}`,
        toolName: "run_build123d",
        content: [{ type: "attachment-reference", attachmentId, kind: "view-sheet", mimeType: "image/png" }],
        details,
        isError: true,
        timestamp: index + 1,
      };
      const response = await app.request(`/api/conversations/${conversation.id}/messages-with-attachments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: {
            id: `malformed-message-${index}`,
            seq: index,
            role: "toolResult",
            contentJson: JSON.stringify(normalized),
          },
          attachments: [{ id: attachmentId, kind: "view-sheet", mime: "image/png", data: PNG_1X1.toString("base64") }],
        }),
      });
      expect(response.status, malformed.name).toBe(409);
    }

    const reloaded = (await (await app.request(`/api/conversations/${conversation.id}/messages`)).json()) as MessageDto[];
    expect(reloaded).toHaveLength(0);
  });

  it("rolls back the entire request for an invalid second image, a duplicate seq, or forged metadata", async () => {
    const { app, db, dataDir } = makePersistentApp();
    const conversation = (await (await app.request("/api/conversations", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Rollback", cadEnvironment: "build123d" }),
    })).json()) as ConversationDto;
    await app.request(`/api/conversations/${conversation.id}/messages`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "existing", seq: 9, role: "user", contentJson: "{}" }),
    });
    const content = (firstKind = "user-image") => JSON.stringify({
      role: "user",
      content: [
        { type: "attachment-reference", attachmentId: "one", kind: firstKind, mimeType: "image/png" },
        { type: "attachment-reference", attachmentId: "two", kind: "user-image", mimeType: "image/png" },
      ],
    });
    const base = {
      message: { id: "failed-atomic", seq: 1, role: "user", contentJson: content() },
      attachments: [
        { id: "one", kind: "user-image", mime: "image/png", data: PNG_1X1.toString("base64") },
        { id: "two", kind: "user-image", mime: "image/png", data: Buffer.from("not an image").toString("base64") },
      ],
    };

    const invalid = await app.request(`/api/conversations/${conversation.id}/messages-with-attachments`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(base),
    });
    expect(invalid.status).toBe(415);
    expect(db.prepare("SELECT id FROM messages WHERE id = 'failed-atomic'").get()).toBeUndefined();
    expect(db.prepare("SELECT id FROM attachments WHERE id IN ('one', 'two')").all()).toEqual([]);
    expect(existsSync(join(dataDir, "images", "43", "431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460")))
      .toBe(false);

    const validAttachments = base.attachments.map((attachment) => ({ ...attachment, data: PNG_1X1.toString("base64") }));
    const conflict = await app.request(`/api/conversations/${conversation.id}/messages-with-attachments`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...base, message: { ...base.message, seq: 9 }, attachments: validAttachments }),
    });
    expect(conflict.status).toBe(409);
    expect(db.prepare("SELECT id FROM messages WHERE id = 'failed-atomic'").get()).toBeUndefined();
    expect(existsSync(join(dataDir, "images", "43", "431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460")))
      .toBe(false);

    const forged = await app.request(`/api/conversations/${conversation.id}/messages-with-attachments`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...base, message: { ...base.message, contentJson: content("view-sheet") }, attachments: validAttachments }),
    });
    expect(forged.status).toBe(409);
    expect(db.prepare("SELECT id FROM messages WHERE id = 'failed-atomic'").get()).toBeUndefined();
  });

  it("honors a caller-supplied logical attachment id used by normalized message content", async () => {
    const { app } = makePersistentApp();
    const message = await createMessageForAttachment(app, "declared-id");

    const upload = await app.request(
      `/api/messages/${message.id}/attachments?id=declared-attachment&kind=user-image&mime=image/png`,
      { method: "POST", headers: { "content-type": "image/png" }, body: PNG_1X1 },
    );

    expect(upload.status).toBe(200);
    expect((await upload.json()) as AttachmentDto).toMatchObject({
      id: "declared-attachment",
      messageId: message.id,
      kind: "user-image",
    });
    expect((await app.request("/api/attachments/declared-attachment")).status).toBe(200);

    const retry = await app.request(
      `/api/messages/${message.id}/attachments?id=declared-attachment&kind=user-image&mime=image/png`,
      { method: "POST", headers: { "content-type": "image/png" }, body: PNG_1X1 },
    );
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as AttachmentDto).id).toBe("declared-attachment");
    expect(((await (await app.request(`/api/messages/${message.id}/attachments`)).json()) as AttachmentDto[])).toHaveLength(1);
  });

  it("stores a verified image with stable metadata and retrieves the original bytes", async () => {
    const { app, db, dataDir } = makePersistentApp();
    const message = await createMessageForAttachment(app);

    const upload = await uploadPng(app, message.id);

    expect(upload.status).toBe(200);
    const attachment = (await upload.json()) as AttachmentDto;
    expect(attachment).toMatchObject({
      messageId: message.id,
      kind: "user-image",
      mime: "image/png",
      contentHash: "431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460",
      byteSize: 68,
      displayOrder: 0,
    });
    expect(attachment).not.toHaveProperty("blobPath");
    expect(attachment).not.toHaveProperty("data");

    const storedMetadata = db.prepare(
      "SELECT data, content_hash, byte_size, mime, blob_path, display_order FROM attachments WHERE id = ?",
    ).get(attachment.id) as Record<string, unknown>;
    expect(storedMetadata).toEqual({
      data: null,
      content_hash: attachment.contentHash,
      byte_size: attachment.byteSize,
      mime: attachment.mime,
      blob_path: `images/43/${attachment.contentHash}`,
      display_order: 0,
    });

    const stored = readFileSync(join(dataDir, "images", "43", attachment.contentHash));
    expect(stored).toEqual(PNG_1X1);
    const retrieval = await app.request(`/api/attachments/${attachment.id}`);
    expect(retrieval.status).toBe(200);
    expect(retrieval.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await retrieval.arrayBuffer())).toEqual(PNG_1X1);
  });

  it("continues retrieving a legacy SQLite-backed attachment before migration", async () => {
    const { app, db } = makePersistentApp();
    const message = await createMessageForAttachment(app);
    db.prepare(
      "INSERT INTO attachments (id, message_id, kind, mime, data) VALUES (?, ?, ?, ?, ?)",
    ).run("legacy-image", message.id, "user-image", "image/png", PNG_1X1);

    const response = await app.request("/api/attachments/legacy-image");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG_1X1);
  });

  it("deduplicates identical bytes while preserving logical attachment identity and order", async () => {
    const { app, dataDir } = makePersistentApp();
    const message = await createMessageForAttachment(app);

    const first = (await (await uploadPng(app, message.id)).json()) as AttachmentDto;
    const second = (await (await uploadPng(app, message.id)).json()) as AttachmentDto;

    expect(second.id).not.toBe(first.id);
    expect(second.contentHash).toBe(first.contentHash);
    expect([first.displayOrder, second.displayOrder]).toEqual([0, 1]);
    expect(readdirSync(join(dataDir, "images", "43"))).toEqual([first.contentHash]);
  });

  it("rejects bytes whose decoded media type does not match the declared media type", async () => {
    const { app } = makePersistentApp();
    const message = await createMessageForAttachment(app);

    const response = await app.request(
      `/api/messages/${message.id}/attachments?kind=user-image&mime=image/jpeg`,
      { method: "POST", body: PNG_1X1 },
    );

    expect(response.status).toBe(415);
    expect(await response.json()).toEqual({ error: "unsupported-media" });
  });

  it("rejects a truncated image that has a valid PNG header and dimensions", async () => {
    const { app } = makePersistentApp();
    const message = await createMessageForAttachment(app);

    const response = await app.request(
      `/api/messages/${message.id}/attachments?kind=user-image&mime=image/png`,
      { method: "POST", body: PNG_1X1.subarray(0, 24) },
    );

    expect(response.status).toBe(415);
    expect(await response.json()).toEqual({ error: "unsupported-media" });
  });

  it("does not commit metadata or leave partial files when atomic rename fails, and retry succeeds", async () => {
    const rename = vi.fn<typeof renameSync>().mockImplementationOnce(() => {
      throw new Error("injected rename failure");
    }).mockImplementation(renameSync);
    const { app, dataDir } = makePersistentApp({ fileSystem: { rename } });
    const message = await createMessageForAttachment(app);

    const failed = await uploadPng(app, message.id);
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: "write-failed" });
    expect(await (await app.request(`/api/messages/${message.id}/attachments`)).json()).toEqual([]);
    expect(readdirSync(join(dataDir, "images", ".tmp"))).toEqual([]);

    const retried = await uploadPng(app, message.id);
    expect(retried.status).toBe(200);
    expect(rename).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["missing", "missing", 404],
    ["corrupt", "corrupt", 422],
    ["unsupported media", "unsupported-media", 415],
    ["path traversal", "path-rejected", 422],
  ] as const)("returns an explicit %s error when stored metadata or bytes are invalid", async (scenario, error, status) => {
    const { app, db, dataDir } = makePersistentApp();
    const message = await createMessageForAttachment(app);
    const attachment = (await (await uploadPng(app, message.id)).json()) as AttachmentDto;
    const blobPath = join(dataDir, "images", "43", attachment.contentHash);

    if (scenario === "missing") rmSync(blobPath);
    if (scenario === "corrupt") writeFileSync(blobPath, Buffer.from("corrupt"));
    if (scenario === "unsupported media") db.prepare("UPDATE attachments SET mime = 'image/tiff' WHERE id = ?").run(attachment.id);
    if (scenario === "path traversal") db.prepare("UPDATE attachments SET blob_path = '../outside.png' WHERE id = ?").run(attachment.id);

    const response = await app.request(`/api/attachments/${attachment.id}`);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error });
  });
});
