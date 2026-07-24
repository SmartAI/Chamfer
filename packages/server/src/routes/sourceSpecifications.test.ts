import { expect, it } from "vitest";
import type { ConversationDto, MessageDto, SourceSpecificationDto } from "@chamfer/shared";
import { createApp } from "../app";
import { openDb } from "../db";

it("serves the durable source-specification projection with retry, conflict, and ownership semantics", async () => {
  const app = createApp(openDb(":memory:"));
  const createConversation = async (title: string) => (await (await app.request("/api/conversations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title, cadEnvironment: "build123d" }),
  })).json()) as ConversationDto;
  const conversation = await createConversation("Source API");
  const other = await createConversation("Other");
  const text = "Build a 30 mm plate.";
  const message = (await (await app.request(`/api/conversations/${conversation.id}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: "message-1",
      seq: 0,
      role: "user",
      contentJson: JSON.stringify({ role: "user", content: text, timestamp: 1 }),
    }),
  })).json()) as MessageDto;
  const input = {
    specifications: [{
      id: "plate-width",
      requirement: "The plate must be 30 mm wide.",
      source: { messageId: message.id, text: "30 mm plate", start: 8, end: 19 },
    }],
  };
  const post = (conversationId: string, body: unknown, key: string) => app.request(
    `/api/conversations/${conversationId}/evidence`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "record-source-specifications", input: body, idempotencyKey: key }),
    },
  );

  const firstResponse = await post(conversation.id, input, "mutation-1");
  expect(firstResponse.status).toBe(200);
  const first = ((await firstResponse.json()) as { result: SourceSpecificationDto[] }).result;
  expect(first).toMatchObject([{
    id: "plate-width",
    conversationId: conversation.id,
    actor: "agent",
    status: "active",
    source: { messageId: "message-1", text: "30 mm plate", start: 8, end: 19 },
  }]);
  expect(((await (await post(conversation.id, input, "mutation-1")).json()) as { result: SourceSpecificationDto[] }).result).toEqual(first);
  const projection = await (await app.request(`/api/conversations/${conversation.id}/evidence`)).json() as { sourceSpecifications: SourceSpecificationDto[] };
  expect(projection.sourceSpecifications).toEqual(first);

  const conflict = structuredClone(input);
  conflict.specifications[0]!.requirement = "The plate may be any width.";
  expect((await post(conversation.id, conflict, "mutation-2")).status).toBe(409);
  const ownership = await post(other.id, input, "mutation-other");
  expect(ownership.status).toBe(400);
  expect(await ownership.json()).toEqual({ error: "source message message-1 does not belong to this conversation" });
});
