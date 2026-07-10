import type { DatabaseSync } from "node:sqlite";
import type { SettingsDto } from "@chamfer/shared";

const SETTINGS_KEYS = [
  "anthropicApiKey",
  "anthropicBaseUrl",
  "openaiApiKey",
  "openaiBaseUrl",
  "googleApiKey",
  "googleBaseUrl",
  "modelJson",
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

/**
 * Upserts one row per field in the given patch. Skips fields that are
 * undefined, and skips values that look like a masked round-trip (start
 * with "***") so the UI can PUT its own masked GET response back without
 * clobbering the stored secret.
 */
export function writeSettings(db: DatabaseSync, patch: SettingsDto): void {
  const stmt = db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  for (const key of SETTINGS_KEYS) {
    const value = patch[key as SettingsKey];
    if (value === undefined) continue;
    if (value.startsWith("***")) continue;
    stmt.run(key, value);
  }
}
