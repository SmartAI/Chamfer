import { describe, expect, it } from "vitest";
import { openDb } from "./db";
import { readEffectiveSettings, readSettings, writeSettings } from "./settingsStore";

describe("writeSettings", () => {
  it("deletes a stored value on explicit null", () => {
    const db = openDb(":memory:");
    writeSettings(db, { anthropicApiKey: "sk-ant-1234" });
    writeSettings(db, { anthropicApiKey: null });
    expect(readSettings(db).anthropicApiKey).toBeUndefined();
  });

  it("deletes a stored value on empty string", () => {
    const db = openDb(":memory:");
    writeSettings(db, { openaiBaseUrl: "https://gw.example" });
    writeSettings(db, { openaiBaseUrl: "" });
    expect(readSettings(db).openaiBaseUrl).toBeUndefined();
  });
});

describe("readEffectiveSettings", () => {
  it("uses env-derived values as the baseline with source env", () => {
    const db = openDb(":memory:");
    const { settings, sources } = readEffectiveSettings(db, { ANTHROPIC_API_KEY: "sk-env" });
    expect(settings.anthropicApiKey).toBe("sk-env");
    expect(sources.anthropicApiKey).toBe("env");
  });

  it("lets stored settings override env, with source db-over-env", () => {
    const db = openDb(":memory:");
    writeSettings(db, { anthropicApiKey: "sk-db" });
    const { settings, sources } = readEffectiveSettings(db, { ANTHROPIC_API_KEY: "sk-env" });
    expect(settings.anthropicApiKey).toBe("sk-db");
    expect(sources.anthropicApiKey).toBe("db-over-env");
  });

  it("marks db-only values with source db and leaves unset keys out of sources", () => {
    const db = openDb(":memory:");
    writeSettings(db, { openaiApiKey: "sk-db" });
    const { settings, sources } = readEffectiveSettings(db, {});
    expect(settings.openaiApiKey).toBe("sk-db");
    expect(sources.openaiApiKey).toBe("db");
    expect(sources.anthropicApiKey).toBeUndefined();
  });
});
