import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { ConversationEvent } from "@chamfer/shared";
import { createApp } from "../app";
import { createConversation, createMessage } from "../conversationStore";
import { initializeSchema } from "../db";

function parseSse(text: string): ConversationEvent[] {
  return text
    .split("\n\n")
    .flatMap((block) => {
      const data = block.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
      return data ? [JSON.parse(data) as ConversationEvent] : [];
    });
}

async function readEvents(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  count: number,
): Promise<ConversationEvent[]> {
  const decoder = new TextDecoder();
  let text = "";
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const next = await reader.read();
    if (next.done) break;
    text += decoder.decode(next.value, { stream: true });
    const events = parseSse(text);
    if (events.length >= count) return events;
  }
  throw new Error(`expected ${count} conversation events, received ${parseSse(text).length}`);
}

describe("conversation event replay stream", () => {
  it("resumes after a disconnect by replaying the suffix before delivering live events", async () => {
    const db = new DatabaseSync(":memory:");
    initializeSchema(db);
    const conversation = createConversation(db, "Reload-safe", "build123d");
    createMessage(db, conversation.id, {
      id: "message-1",
      seq: 0,
      role: "user",
      contentJson: JSON.stringify({ role: "user", content: "first" }),
    });
    const app = createApp(db);

    const firstAbort = new AbortController();
    const firstResponse = await app.request(`/api/conversations/${conversation.id}/events`, {
      signal: firstAbort.signal,
    });
    const firstReader = firstResponse.body!.getReader();
    const initial = await readEvents(firstReader, 2);
    expect(initial.map((event) => event.sequence)).toEqual([1, 2]);
    firstAbort.abort();
    await firstReader.cancel().catch(() => undefined);

    createMessage(db, conversation.id, {
      id: "message-2",
      seq: 1,
      role: "assistant",
      contentJson: JSON.stringify({ role: "assistant", content: [{ type: "text", text: "second" }] }),
    });
    const resumedAbort = new AbortController();
    const resumedResponse = await app.request(`/api/conversations/${conversation.id}/events?after=2`, {
      signal: resumedAbort.signal,
    });
    const resumedReader = resumedResponse.body!.getReader();
    const resumed = await readEvents(resumedReader, 1);
    expect(resumed.map((event) => [event.sequence, event.type])).toEqual([[3, "message.appended"]]);

    createMessage(db, conversation.id, {
      id: "message-3",
      seq: 2,
      role: "user",
      contentJson: JSON.stringify({ role: "user", content: "third" }),
    });
    const live = await readEvents(resumedReader, 1);
    expect(live.map((event) => [event.sequence, event.type])).toEqual([[4, "message.appended"]]);
    const uiResponse = await app.request(`/api/conversations/${conversation.id}/ui-state/right-panel`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: { tab: "parameters" } }),
    });
    expect(uiResponse.status).toBe(200);
    const uiEvent = await readEvents(resumedReader, 1);
    expect(uiEvent.map((event) => [event.sequence, event.type])).toEqual([[5, "ui.state-updated"]]);
    const projection = await (await app.request(
      `/api/conversations/${conversation.id}/conversation-state`,
    )).json() as { messages: Array<{ id: string }>; uiState: Record<string, unknown> };
    expect(projection.messages.map((message) => message.id)).toEqual(["message-1", "message-2", "message-3"]);
    expect(projection.uiState).toEqual({ "right-panel": { tab: "parameters" } });
    resumedAbort.abort();
    await resumedReader.cancel().catch(() => undefined);
  });
});
