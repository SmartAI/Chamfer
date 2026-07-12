import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { DEFAULT_CONVERSATION_TITLE } from "@chamfer/shared";
import { openDb } from "./db";
import { createApp } from "./app";
import { sanitizeTitle } from "./titles";
import type { LlmStreamer } from "./llm";

const MODEL_JSON = JSON.stringify({ provider: "anthropic", id: "test-model" });

/** Streamer that answers every call with the given text and records its inputs. */
function textStreamer(text: string): LlmStreamer & { calls: Array<{ model: unknown; context: unknown; options: Record<string, unknown> }> } {
  const calls: Array<{ model: unknown; context: unknown; options: Record<string, unknown> }> = [];
  return {
    calls,
    async *stream(model, context, options) {
      calls.push({ model, context, options });
      yield { type: "start", partial: {} } as never;
      yield { type: "text_start", contentIndex: 0, partial: {} } as never;
      yield { type: "text_delta", contentIndex: 0, delta: text, partial: {} } as never;
      yield { type: "text_end", contentIndex: 0, partial: {} } as never;
      yield {
        type: "done",
        message: { stopReason: "stop", content: [{ type: "text", text }] },
      } as never;
    },
  };
}

const erroringStreamer: LlmStreamer = {
  async *stream() {
    yield { type: "start", partial: {} } as never;
    throw new Error("upstream provider exploded");
  },
};

interface Setup {
  app: ReturnType<typeof createApp>;
  conversationId: string;
}

async function setup(
  llm: LlmStreamer,
  opts?: { modelJson?: string | null; messages?: boolean; db?: DatabaseSync },
): Promise<Setup> {
  const app = createApp(opts?.db ?? openDb(":memory:"), llm);
  if (opts?.modelJson !== null) {
    const put = await app.request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ modelJson: opts?.modelJson ?? MODEL_JSON }),
    });
    expect(put.status).toBe(200);
  }
  const created = await app.request("/api/conversations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: DEFAULT_CONVERSATION_TITLE }),
  });
  const conversation = (await created.json()) as { id: string };
  if (opts?.messages !== false) {
    const userMessage = { role: "user", content: "make me a 10mm gear", timestamp: 1 };
    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Here is a parametric gear." }],
      timestamp: 2,
    };
    for (const [seq, message] of [userMessage, assistantMessage].entries()) {
      const res = await app.request(`/api/conversations/${conversation.id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: `msg-${seq}`,
          seq,
          role: message.role,
          contentJson: JSON.stringify(message),
        }),
      });
      expect(res.status).toBe(200);
    }
  }
  return { app, conversationId: conversation.id };
}

async function currentTitle(app: Setup["app"], id: string): Promise<string> {
  const res = await app.request("/api/conversations");
  const list = (await res.json()) as Array<{ id: string; title: string }>;
  return list.find((c) => c.id === id)?.title ?? "<missing>";
}

describe("POST /api/conversations/:id/generate-title", () => {
  it("generates, persists, and returns a title from the transcript", async () => {
    const llm = textStreamer("Parametric Gear Design");
    const { app, conversationId } = await setup(llm);

    const res = await app.request(`/api/conversations/${conversationId}/generate-title`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ title: "Parametric Gear Design", generated: true });
    expect(await currentTitle(app, conversationId)).toBe("Parametric Gear Design");

    // The summarization call carries the transcript, not the raw chat context.
    expect(llm.calls).toHaveLength(1);
    const context = llm.calls[0]?.context as { systemPrompt: string; messages: Array<{ content: Array<{ text: string }> }> };
    expect(context.systemPrompt).toContain("title");
    const promptText = context.messages[0]?.content[0]?.text ?? "";
    expect(promptText).toContain("User: make me a 10mm gear");
    expect(promptText).toContain("Assistant: Here is a parametric gear.");
    expect(llm.calls[0]?.options.sessionId).toBe(conversationId);
  });

  it("sanitizes quoted, multi-line, punctuated model output", async () => {
    const llm = textStreamer('  "Gear Bracket Modeling."  \nSecond line ignored');
    const { app, conversationId } = await setup(llm);

    const res = await app.request(`/api/conversations/${conversationId}/generate-title`, { method: "POST" });
    expect(await res.json()).toEqual({ title: "Gear Bracket Modeling", generated: true });
  });

  it("is idempotent: a second call keeps the generated title without calling the LLM again", async () => {
    const llm = textStreamer("Parametric Gear Design");
    const { app, conversationId } = await setup(llm);

    const first = await app.request(`/api/conversations/${conversationId}/generate-title`, { method: "POST" });
    expect(await first.json()).toEqual({ title: "Parametric Gear Design", generated: true });

    const second = await app.request(`/api/conversations/${conversationId}/generate-title`, { method: "POST" });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ title: "Parametric Gear Design", generated: false });
    expect(llm.calls).toHaveLength(1);
  });

  it("returns 404 for an unknown conversation", async () => {
    const { app } = await setup(textStreamer("x"));
    const res = await app.request("/api/conversations/nope/generate-title", { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("returns 400 when no model is configured", async () => {
    const { app, conversationId } = await setup(textStreamer("x"), { modelJson: null });
    const res = await app.request(`/api/conversations/${conversationId}/generate-title`, { method: "POST" });
    expect(res.status).toBe(400);
  });

  it("returns 502 and keeps the default title when the LLM fails", async () => {
    const { app, conversationId } = await setup(erroringStreamer);
    const res = await app.request(`/api/conversations/${conversationId}/generate-title`, { method: "POST" });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe("upstream provider exploded");
    expect(await currentTitle(app, conversationId)).toBe(DEFAULT_CONVERSATION_TITLE);
  });

  it("persists the generated title in sqlite across server restarts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chamfer-titles-"));
    const dbPath = join(dir, "chamfer.db");
    try {
      const db1 = openDb(dbPath);
      const { app, conversationId } = await setup(textStreamer("Parametric Gear Design"), { db: db1 });
      const res = await app.request(`/api/conversations/${conversationId}/generate-title`, { method: "POST" });
      expect(res.status).toBe(200);
      db1.close();

      // A fresh process over the same db file (the user reopening the site)
      // serves the stored title straight from the conversations table.
      const db2 = openDb(dbPath);
      const reopenedApp = createApp(db2, textStreamer("Should Not Be Used"));
      expect(await currentTitle(reopenedApp, conversationId)).toBe("Parametric Gear Design");
      db2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses an env-configured model and key when no settings are stored", async () => {
    const modelId = (builtinModels().getModels("anthropic")[0] as { id: string }).id;
    vi.stubEnv("CHAMFER_MODEL", modelId);
    vi.stubEnv("CHAMFER_PROVIDER", "anthropic");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-envonly");
    try {
      const llm = textStreamer("Env Config Title");
      const { app, conversationId } = await setup(llm, { modelJson: null });
      const res = await app.request(`/api/conversations/${conversationId}/generate-title`, { method: "POST" });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { title: string }).title).toBe("Env Config Title");
      expect(llm.calls[0]?.options.apiKey).toBe("sk-ant-envonly");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("skips generation when the conversation has no summarizable text", async () => {
    const llm = textStreamer("Should Not Be Used");
    const { app, conversationId } = await setup(llm, { messages: false });
    const res = await app.request(`/api/conversations/${conversationId}/generate-title`, { method: "POST" });
    expect(await res.json()).toEqual({ title: DEFAULT_CONVERSATION_TITLE, generated: false });
    expect(llm.calls).toHaveLength(0);
  });
});

describe("sanitizeTitle", () => {
  it("strips wrapping quotes and trailing punctuation", () => {
    expect(sanitizeTitle('"Parametric Gear Design."')).toBe("Parametric Gear Design");
    expect(sanitizeTitle("'Box with fillets!'")).toBe("Box with fillets");
  });

  it("keeps only the first non-empty line and collapses whitespace", () => {
    expect(sanitizeTitle("\n\n  Gear   Bracket \nExplanation follows")).toBe("Gear Bracket");
  });

  it("caps overlong titles with an ellipsis", () => {
    const long = "word ".repeat(30).trim();
    const result = sanitizeTitle(long);
    expect(result.length).toBeLessThanOrEqual(61);
    expect(result.endsWith("…")).toBe(true);
  });

  it("returns empty for unusable output", () => {
    expect(sanitizeTitle("   \n  ")).toBe("");
    expect(sanitizeTitle('""')).toBe("");
  });
});
