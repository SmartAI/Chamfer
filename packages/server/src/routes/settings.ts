import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import type { SettingsPatchDto, SettingsResponseDto } from "@chamfer/shared";
import { readEffectiveSettings, writeSettings } from "../settingsStore";
import { FAKE_MODEL } from "../fakeLlm";
import { fusionIntegrityAccessFromEnv } from "../fusion/integrityGate";

function mask(value: string | undefined): string {
  return value ? "***" + value.slice(-4) : "";
}

export function settingsRoutes(
  db: DatabaseSync,
  fakeMode = process.env.CHAMFER_FAKE_LLM === "1",
  /** Model reported when the user has not chosen one. The online deployment
   * passes its demo-quota model here so a fresh account can chat immediately;
   * locally there is no key to fall back on, so it stays unset. */
  defaultModelJson?: string,
): Hono {
  const app = new Hono();

  app.get("/api/settings", (c) => {
    const { settings, sources } = readEffectiveSettings(db);
    const fusionIntegrity = fusionIntegrityAccessFromEnv();
    const masked: SettingsResponseDto = {
      anthropicApiKey: mask(settings.anthropicApiKey),
      anthropicBaseUrl: settings.anthropicBaseUrl,
      openaiApiKey: mask(settings.openaiApiKey),
      openaiBaseUrl: settings.openaiBaseUrl,
      googleApiKey: mask(settings.googleApiKey),
      googleBaseUrl: settings.googleBaseUrl,
      modelJson: settings.modelJson ?? (fakeMode ? JSON.stringify(FAKE_MODEL) : defaultModelJson),
      maxCadRuns: settings.maxCadRuns,
      showCadCode: settings.showCadCode,
      fusionMcpEndpoint: settings.fusionMcpEndpoint,
      experimentalFusionEnabled: process.env.CHAMFER_EXPERIMENTAL_FUSION === "1",
      fusionEnabled: fusionIntegrity.enabled,
      fusionIntegrity,
      sources,
    };
    return c.json(masked);
  });

  app.put("/api/settings", async (c) => {
    const patch = (await c.req.json()) as SettingsPatchDto;
    try {
      writeSettings(db, patch);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
    return c.json({ ok: true });
  });

  return app;
}
