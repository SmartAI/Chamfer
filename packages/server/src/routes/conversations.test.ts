import { describe, expect, it } from "vitest";
import { openDb } from "../db";
import { createApp } from "../app";
import type { ConversationDto, MessageDto, AttachmentDto } from "@chamfer/shared";

function makeApp() {
  return createApp(openDb(":memory:"));
}

describe("conversations routes", () => {
  it("supports the full conversation lifecycle", async () => {
    const app = makeApp();

    // Create conversation
    const createRes = await app.request("/api/conversations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "My chat" }),
    });
    expect(createRes.status).toBe(200);
    const conversation = (await createRes.json()) as ConversationDto;
    expect(conversation.id).toBeTruthy();
    expect(conversation.title).toBe("My chat");
    expect(conversation.createdAt).toBeTypeOf("number");
    expect(conversation.updatedAt).toBeTypeOf("number");

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

    // Upload a 3-byte attachment
    const bytes = new Uint8Array([1, 2, 3]);
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
    expect(fetchedBytes).toEqual(bytes);

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
  });

  it("returns 409 with a structured error on duplicate (conversation_id, seq)", async () => {
    const app = makeApp();

    const createRes = await app.request("/api/conversations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Dup seq" }),
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
      body: JSON.stringify({ title: "Bad kind" }),
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
