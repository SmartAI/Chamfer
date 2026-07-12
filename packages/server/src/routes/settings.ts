import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import type { SettingsPatchDto, SettingsResponseDto } from "@chamfer/shared";
import { readEffectiveSettings, writeSettings } from "../settingsStore";
import { FAKE_MODEL } from "../fakeLlm";

function mask(value: string | undefined): string {
  return value ? "***" + value.slice(-4) : "";
}

export function settingsRoutes(db: DatabaseSync, fakeMode = process.env.CHAMFER_FAKE_LLM === "1"): Hono {
  const app = new Hono();

  app.get("/api/settings", (c) => {
    const { settings, sources } = readEffectiveSettings(db);
    const masked: SettingsResponseDto = {
      anthropicApiKey: mask(settings.anthropicApiKey),
      anthropicBaseUrl: settings.anthropicBaseUrl,
      openaiApiKey: mask(settings.openaiApiKey),
      openaiBaseUrl: settings.openaiBaseUrl,
      googleApiKey: mask(settings.googleApiKey),
      googleBaseUrl: settings.googleBaseUrl,
      modelJson: settings.modelJson ?? (fakeMode ? JSON.stringify(FAKE_MODEL) : undefined),
      maxCadRuns: settings.maxCadRuns,
      showCadCode: settings.showCadCode,
      sources,
    };
    return c.json(masked);
  });

  app.put("/api/settings", async (c) => {
    const patch = (await c.req.json()) as SettingsPatchDto;
    writeSettings(db, patch);
    return c.json({ ok: true });
  });

  return app;
}
