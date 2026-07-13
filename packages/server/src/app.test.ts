import { describe, expect, it } from "vitest";
import { openDb } from "./db";
import { createApp } from "./app";
import { fakeLlm } from "./fakeLlm";

describe("app", () => {
  it("answers health", async () => {
    const app = createApp(openDb(":memory:"));
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("exposes privacy-safe diagnostics and fake request captures", async () => {
    const db = openDb(":memory:");
    const llm = fakeLlm();
    const app = createApp(db, llm);
    const created = await (await app.request("/api/conversations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "secret title" }),
    })).json() as { id: string };

    for await (const _event of llm.stream({}, {
      messages: [{ role: "user", content: [{ type: "text", text: "attachment-replay private" }] }],
    }, { sessionId: created.id })) {
      // Drain the fake stream so its diagnostic capture represents a completed request.
    }

    const requests = await (await app.request(`/api/test/fake-model-requests?conversationId=${created.id}`)).json();
    expect(requests).toMatchObject({
      requests: [{ sequence: 1, messageCount: 1, imageCount: 0 }],
      exposure: { requestCount: 1, totalImageExposures: 0 },
    });
    expect(JSON.stringify(requests)).not.toContain("private");

    const lifecycle = await (await app.request(`/api/conversations/${created.id}/image-diagnostics`)).json();
    expect(lifecycle).toEqual({ conversationId: created.id, attachments: [] });
  });

  it("does not install the fake request capture route for ordinary streamers", async () => {
    const app = createApp(openDb(":memory:"), {
      async *stream() { return; },
    });
    expect((await app.request("/api/test/fake-model-requests")).status).toBe(404);
  });
});
