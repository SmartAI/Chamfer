import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import type { SettingsDto } from "@chamfer/shared";
import { readSettings, writeSettings } from "../settingsStore";
import { FAKE_MODEL } from "../fakeLlm";

function mask(value: string | undefined): string {
  return value ? "***" + value.slice(-4) : "";
}

export function settingsRoutes(db: DatabaseSync, fakeMode = process.env.CHAMFER_FAKE_LLM === "1"): Hono {
  const app = new Hono();

  app.get("/api/settings", (c) => {
    const raw = readSettings(db);
    const masked: SettingsDto = {
      anthropicApiKey: mask(raw.anthropicApiKey),
      anthropicBaseUrl: raw.anthropicBaseUrl,
      openaiApiKey: mask(raw.openaiApiKey),
      openaiBaseUrl: raw.openaiBaseUrl,
      googleApiKey: mask(raw.googleApiKey),
      googleBaseUrl: raw.googleBaseUrl,
      modelJson: raw.modelJson ?? (fakeMode ? JSON.stringify(FAKE_MODEL) : undefined),
    };
    return c.json(masked);
  });

  app.put("/api/settings", async (c) => {
    const patch = (await c.req.json()) as SettingsDto;
    writeSettings(db, patch);
    return c.json({ ok: true });
  });

  return app;
}
