import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { openDb } from "../db";
import { createConversation } from "../conversationStore";
import { fakeLlm } from "../fakeLlm";
import { fakeLlmTestControlRoutes } from "./fakeLlmTestControls";

describe("fake LLM test controls", () => {
  it("holds a scripted request until its conversation is explicitly released", async () => {
    const db = openDb(":memory:");
    const conversation = createConversation(db, "held request");
    const llm = fakeLlm();
    const app = new Hono().route("/", fakeLlmTestControlRoutes(db, llm));
    const drain = (async () => {
      for await (const _event of llm.stream({}, {
        messages: [{ role: "user", content: [{ type: "text", text: "follow-up-steering-hold" }] }],
      }, { sessionId: conversation.id })) {
        // The request must remain suspended until the release route resolves its latch.
      }
    })();

    await vi.waitUntil(() => llm.isRequestHeld(conversation.id));
    const held = await app.request(`/api/test/fake-model-holds?conversationId=${conversation.id}`);
    expect(await held.json()).toEqual({ held: true });

    const released = await app.request(`/api/test/fake-model-holds/release?conversationId=${conversation.id}`, {
      method: "POST",
    });
    expect(await released.json()).toEqual({ released: true });
    await drain;

    const requests = await app.request(`/api/test/fake-model-requests?conversationId=${conversation.id}`);
    expect(await requests.json()).toMatchObject({ requests: [{ sequence: 1, messageCount: 1 }] });
  });
});
