import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AttachmentDto, ConversationDto, InspectionLeaseDto, MessageDto } from "@chamfer/shared";
import { createApp } from "./app";
import { openDb } from "./db";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const dirs: string[] = [];

async function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "chamfer-leases-"));
  dirs.push(dataDir);
  const db = openDb(join(dataDir, "chamfer.db"));
  const app = createApp(db, undefined, { dataDir });
  const conversation = await createConversation(app);
  const message = await createMessage(app, conversation.id, "message-1");
  const attachment = await upload(app, message.id, "evidence-1");
  return { app, db, dataDir, conversation, attachment };
}

async function createConversation(app: ReturnType<typeof createApp>) {
  return await (await app.request("/api/conversations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Lease test", cadEnvironment: "build123d" }),
  })).json() as ConversationDto;
}

async function createMessage(app: ReturnType<typeof createApp>, conversationId: string, id: string) {
  return await (await app.request(`/api/conversations/${conversationId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, seq: 0, role: "user", contentJson: "{}" }),
  })).json() as MessageDto;
}

async function upload(app: ReturnType<typeof createApp>, messageId: string, id: string) {
  return await (await app.request(`/api/messages/${messageId}/attachments?id=${id}&kind=user-image&mime=image/png`, {
    method: "POST",
    body: PNG,
  })).json() as AttachmentDto;
}

async function openLease(app: ReturnType<typeof createApp>, conversationId: string, evidenceIds = ["evidence-1"]) {
  return app.request(`/api/conversations/${conversationId}/evidence`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "open-inspection-lease",
      input: { evidenceIds, purpose: "Compare the mounting profile" },
      idempotencyKey: crypto.randomUUID(),
    }),
  });
}

async function openLeases(app: ReturnType<typeof createApp>, conversationId: string) {
  const projection = await (await app.request(`/api/conversations/${conversationId}/evidence`)).json() as {
    inspectionLeases: InspectionLeaseDto[];
  };
  return projection.inspectionLeases.filter((lease) => lease.status === "open");
}

async function result<T>(response: Response): Promise<T> {
  return ((await response.json()) as { result: T }).result;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("inspection leases", () => {
  it("opens only after verifying exact conversation-owned evidence and reloads the selection", async () => {
    const { app, conversation } = await fixture();
    const response = await openLease(app, conversation.id);
    expect(response.status).toBe(200);
    const lease = await result<InspectionLeaseDto>(response);
    expect(lease).toMatchObject({
      conversationId: conversation.id,
      status: "open",
      purpose: "Compare the mounting profile",
      evidence: [{ attachmentId: "evidence-1", kind: "user-image", mime: "image/png" }],
    });

    const reloaded = await openLeases(app, conversation.id);
    expect(reloaded).toEqual([lease]);
  });

  it("rejects foreign ownership without opening a lease", async () => {
    const { app, conversation } = await fixture();
    const other = await createConversation(app);
    const response = await openLease(app, other.id);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "evidence evidence-1 does not belong to this conversation" });
    expect(await openLeases(app, conversation.id)).toEqual([]);
  });

  it("reports corrupt evidence explicitly and never marks it leased or observed", async () => {
    const { app, db, dataDir, conversation, attachment } = await fixture();
    const row = db.prepare("SELECT blob_path FROM attachments WHERE id = ?").get(attachment.id) as { blob_path: string };
    writeFileSync(join(dataDir, row.blob_path), "not the stored image");
    const response = await openLease(app, conversation.id);
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "evidence evidence-1 is corrupt" });
    expect(await openLeases(app, conversation.id)).toEqual([]);
  });

  it("reports missing evidence explicitly without opening a lease", async () => {
    const { app, db, dataDir, conversation, attachment } = await fixture();
    const row = db.prepare("SELECT blob_path FROM attachments WHERE id = ?").get(attachment.id) as { blob_path: string };
    rmSync(join(dataDir, row.blob_path));
    const response = await openLease(app, conversation.id);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "evidence evidence-1 is missing" });
    expect(await openLeases(app, conversation.id)).toEqual([]);
  });

  it("keeps a lease open after rejected observations, then atomically records and closes it", async () => {
    const { app, conversation } = await fixture();
    const lease = await result<InspectionLeaseDto>(await openLease(app, conversation.id));
    const invalid = await app.request(`/api/conversations/${conversation.id}/evidence`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "record-inspection-observation", leaseId: lease.id, idempotencyKey: "invalid-observation",
        input: { relevantViews: [], facts: [], affectedSpecifications: [], affectedComponents: [] },
      }),
    });
    expect(invalid.status).toBe(400);
    expect(await openLeases(app, conversation.id)).toEqual([lease]);

    const valid = await app.request(`/api/conversations/${conversation.id}/evidence`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "record-inspection-observation", leaseId: lease.id, idempotencyKey: "valid-observation", input: {
        relevantViews: ["front", "isometric"], facts: ["The flange projects beyond the body on both sides."],
        affectedSpecifications: ["spec.mount-width"], affectedComponents: ["mount"],
      } }),
    });
    expect(valid.status).toBe(200);
    expect(await result<InspectionLeaseDto>(valid)).toMatchObject({ status: "closed", observation: {
      relevantViews: ["front", "isometric"],
      facts: ["The flange projects beyond the body on both sides."],
    } });
    expect(await openLeases(app, conversation.id)).toEqual([]);
  });

  it("replays keyed lease and observation mutations exactly and conflicts on changed payloads", async () => {
    const { app, db, conversation } = await fixture();
    const leaseInput = { evidenceIds: ["evidence-1"], purpose: "Compare the mounting profile" };
    const open = () => app.request(`/api/conversations/${conversation.id}/evidence`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        type: "open-inspection-lease", input: leaseInput, idempotencyKey: "lease-call-1",
      }),
    });
    const firstLease = await result<InspectionLeaseDto>(await open());
    expect(await result<InspectionLeaseDto>(await open())).toEqual(firstLease);
    expect(db.prepare("SELECT COUNT(*) AS count FROM evidence_events WHERE type = 'inspection-lease.opened'").get()).toEqual({ count: 1 });
    const leaseConflict = await app.request(`/api/conversations/${conversation.id}/evidence`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        type: "open-inspection-lease", input: { ...leaseInput, purpose: "Changed" }, idempotencyKey: "lease-call-1",
      }),
    });
    expect(leaseConflict.status).toBe(409);

    const observation = {
      relevantViews: ["front"], facts: ["The flange projects."],
      affectedSpecifications: ["spec.mount-width"], affectedComponents: [],
    };
    const observationUrl = `/api/conversations/${conversation.id}/evidence`;
    const record = () => app.request(observationUrl, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        type: "record-inspection-observation", leaseId: firstLease.id, input: observation,
        idempotencyKey: "observation-call-1",
      }),
    });
    const firstClosed = await result<InspectionLeaseDto>(await record());
    expect(await result<InspectionLeaseDto>(await record())).toEqual(firstClosed);
    expect(db.prepare("SELECT COUNT(*) AS count FROM evidence_events WHERE type = 'inspection-lease.closed'").get()).toEqual({ count: 1 });
    const observationConflict = await app.request(observationUrl, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        type: "record-inspection-observation", leaseId: firstLease.id,
        input: { ...observation, facts: ["Changed."] }, idempotencyKey: "observation-call-1",
      }),
    });
    expect(observationConflict.status).toBe(409);
  });
});
