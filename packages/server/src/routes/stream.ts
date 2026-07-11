import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import { streamSSE } from "hono/streaming";
import { PROXY_AUTH_TOKEN } from "@chamfer/shared";
import type { ProxyAssistantMessageEvent } from "@earendil-works/pi-agent-core";
import { toProxyEvent } from "../proxyEvents";
import { readEffectiveSettings } from "../settingsStore";
import { resolveProviderConfig } from "../providerConfig";
import type { LlmStreamer } from "../llm";

/** Zeroed usage reported alongside a mid-stream error: the provider call was
 *  interrupted before pi-ai could compute real token/cost figures. */
const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export function streamRoutes(db: DatabaseSync, llm: LlmStreamer): Hono {
  const app = new Hono();

  app.post("/api/stream", async (c) => {
    if (c.req.header("authorization") !== `Bearer ${PROXY_AUTH_TOKEN}`) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const { model, context, options } = (await c.req.json()) as {
      model: unknown;
      context: unknown;
      options: Record<string, unknown>;
    };
    const { requestModel, apiKey, env } = resolveProviderConfig(readEffectiveSettings(db).settings, model);
    return streamSSE(c, async (stream) => {
      try {
        for await (const event of llm.stream(requestModel, context, {
          ...options,
          apiKey,
          env,
          signal: c.req.raw.signal,
        })) {
          const proxyEvent = toProxyEvent(event);
          if (proxyEvent) await stream.writeSSE({ data: JSON.stringify(proxyEvent) });
        }
      } catch (e) {
        // Wire contract requires an in-band error event: without this, Hono's
        // streamSSE would swallow the throw (console.error + close), leaving
        // the client with a silently truncated 200 stream. Only the thrown
        // error's own message is forwarded — never options/env — so API key
        // material passed to the provider call can never leak into the
        // response body.
        const errorMessage = e instanceof Error ? e.message : String(e);
        const errorEvent: ProxyAssistantMessageEvent = {
          type: "error",
          reason: "error",
          errorMessage,
          usage: ZERO_USAGE,
        };
        await stream.writeSSE({ data: JSON.stringify(errorEvent) });
      }
    });
  });

  return app;
}
