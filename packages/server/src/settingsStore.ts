import type { DatabaseSync } from "node:sqlite";
import type { SettingsDto, SettingsPatchDto, SettingsSources } from "@chamfer/shared";
import { envSettings } from "./envConfig";

const SETTINGS_KEYS = [
  "anthropicApiKey",
  "anthropicBaseUrl",
  "openaiApiKey",
  "openaiBaseUrl",
  "googleApiKey",
  "googleBaseUrl",
  "modelJson",
  "maxCadRuns",
  "showCadCode",
] as const;

type SettingsKey = (typeof SETTINGS_KEYS)[number];

/** Reads raw (unmasked) settings values from the settings table. */
export function readSettings(db: DatabaseSync): SettingsDto {
  const result: SettingsDto = {};
  const stmt = db.prepare("SELECT value FROM settings WHERE key = ?");
  for (const key of SETTINGS_KEYS) {
    const row = stmt.get(key) as { value: string } | undefined;
    if (row !== undefined) {
      result[key] = row.value;
    }
  }
  return result;
}

export interface EffectiveSettings {
  /** Env-derived baseline with stored settings layered on top. */
  settings: SettingsDto;
  sources: SettingsSources;
}

/**
 * Merges the environment baseline (envSettings) with the settings table.
 * Stored values win; env values are a live overlay and are never persisted,
 * so deleting a stored value falls back to the environment.
 */
export function readEffectiveSettings(
  db: DatabaseSync,
  env: Record<string, string | undefined> = process.env,
): EffectiveSettings {
  const fromEnv = envSettings(env);
  const fromDb = readSettings(db);
  const settings: SettingsDto = { ...fromEnv, ...fromDb };
  const sources: SettingsSources = {};
  for (const key of SETTINGS_KEYS) {
    if (fromDb[key] !== undefined) {
      sources[key] = fromEnv[key] !== undefined ? "db-over-env" : "db";
    } else if (fromEnv[key] !== undefined) {
      sources[key] = "env";
    }
  }
  return { settings, sources };
}

/**
 * Upserts one row per field in the given patch. Skips fields that are
 * undefined, and skips values that look like a masked round-trip (start
 * with "***") so the UI can PUT its own masked GET response back without
 * clobbering the stored secret. Null or empty values delete the stored row,
 * reverting the key to its environment baseline.
 */
export function writeSettings(db: DatabaseSync, patch: SettingsPatchDto): void {
  const upsert = db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  const remove = db.prepare("DELETE FROM settings WHERE key = ?");
  for (const key of SETTINGS_KEYS) {
    const value = patch[key as SettingsKey];
    if (value === undefined) continue;
    if (value === null || value === "") {
      remove.run(key);
      continue;
    }
    if (value.startsWith("***")) continue;
    upsert.run(key, value);
  }
}
