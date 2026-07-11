import { afterEach, describe, expect, it, vi } from "vitest";
import type { SettingsResponseDto } from "@chamfer/shared";
import { openDb } from "../db";
import { createApp } from "../app";

function makeApp() {
  return createApp(openDb(":memory:"));
}

describe("settings routes", () => {
  it("round-trips keys and masks them on read", async () => {
    const app = makeApp();
    const put = await app.request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        anthropicApiKey: "sk-ant-12345678",
        anthropicBaseUrl: "https://gateway.example/anthropic",
      }),
    });
    expect(put.status).toBe(200);
    const got = (await (await app.request("/api/settings")).json()) as {
      anthropicApiKey: string;
      anthropicBaseUrl: string;
    };
    expect(got.anthropicApiKey).toBe("***5678");
    expect(got.anthropicBaseUrl).toBe("https://gateway.example/anthropic");
  });

  it("ignores masked values on write", async () => {
    const app = makeApp();
    await app.request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ anthropicApiKey: "sk-ant-12345678" }),
    });
    await app.request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ anthropicApiKey: "***5678", openaiApiKey: "sk-oai-abcd" }),
    });
    const got = (await (await app.request("/api/settings")).json()) as Record<string, string>;
    expect(got.anthropicApiKey).toBe("***5678"); // unchanged, not overwritten with the mask
    expect(got.openaiApiKey).toBe("***abcd");
  });
});

describe("settings routes with environment config", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reports env-derived values masked, with source env", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-envkey99");
    const app = makeApp();
    const got = (await (await app.request("/api/settings")).json()) as SettingsResponseDto;
    expect(got.anthropicApiKey).toBe("***ey99");
    expect(got.sources.anthropicApiKey).toBe("env");
  });

  it("marks a stored value shadowing an env value as db-over-env", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-oai-fromenv");
    const app = makeApp();
    await app.request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ openaiApiKey: "sk-oai-fromdb1" }),
    });
    const got = (await (await app.request("/api/settings")).json()) as SettingsResponseDto;
    expect(got.openaiApiKey).toBe("***mdb1");
    expect(got.sources.openaiApiKey).toBe("db-over-env");
  });

  it("round-trips maxCadRuns with env baseline and db override", async () => {
    vi.stubEnv("CHAMFER_MAX_CAD_RUNS", "25");
    const app = makeApp();
    let got = (await (await app.request("/api/settings")).json()) as SettingsResponseDto;
    expect(got.maxCadRuns).toBe("25");
    expect(got.sources.maxCadRuns).toBe("env");

    await app.request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ maxCadRuns: "5" }),
    });
    got = (await (await app.request("/api/settings")).json()) as SettingsResponseDto;
    expect(got.maxCadRuns).toBe("5");
    expect(got.sources.maxCadRuns).toBe("db-over-env");
  });

  it("PUT null deletes the override and falls back to the env value", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-oai-fromenv");
    const app = makeApp();
    await app.request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ openaiApiKey: "sk-oai-fromdb1" }),
    });
    await app.request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ openaiApiKey: null }),
    });
    const got = (await (await app.request("/api/settings")).json()) as SettingsResponseDto;
    expect(got.openaiApiKey).toBe("***menv");
    expect(got.sources.openaiApiKey).toBe("env");
  });
});
