import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { envSettings, loadDotenv } from "./envConfig";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "chamfer-env-"));
}

describe("loadDotenv", () => {
  it("loads .env values into the target env", () => {
    const dir = tempDir();
    writeFileSync(join(dir, ".env"), "ANTHROPIC_API_KEY=sk-from-file\n");
    const env: Record<string, string | undefined> = {};
    const result = loadDotenv(dir, env);
    expect(env.ANTHROPIC_API_KEY).toBe("sk-from-file");
    expect(result.files).toEqual([join(dir, ".env")]);
  });

  it("lets .env.local override .env", () => {
    const dir = tempDir();
    writeFileSync(join(dir, ".env"), "OPENAI_API_KEY=base\nPORT=9999\n");
    writeFileSync(join(dir, ".env.local"), "OPENAI_API_KEY=local\n");
    const env: Record<string, string | undefined> = {};
    loadDotenv(dir, env);
    expect(env.OPENAI_API_KEY).toBe("local");
    expect(env.PORT).toBe("9999");
  });

  it("never overrides variables already present in the real environment", () => {
    const dir = tempDir();
    writeFileSync(join(dir, ".env"), "ANTHROPIC_API_KEY=from-file\n");
    const env: Record<string, string | undefined> = { ANTHROPIC_API_KEY: "from-shell" };
    loadDotenv(dir, env);
    expect(env.ANTHROPIC_API_KEY).toBe("from-shell");
  });

  it("walks up parent directories to the nearest dotenv file", () => {
    const root = tempDir();
    writeFileSync(join(root, ".env"), "GOOGLE_API_KEY=parent\n");
    const nested = join(root, "a", "b");
    mkdirSync(nested, { recursive: true });
    const env: Record<string, string | undefined> = {};
    loadDotenv(nested, env);
    expect(env.GOOGLE_API_KEY).toBe("parent");
  });

  it("is a no-op when no dotenv file exists anywhere up the tree", () => {
    const dir = tempDir();
    const env: Record<string, string | undefined> = {};
    const result = loadDotenv(dir, env);
    expect(result.files).toEqual([]);
    expect(env).toEqual({});
  });
});

describe("envSettings", () => {
  it("maps provider env vars to settings fields", () => {
    const settings = envSettings({
      ANTHROPIC_API_KEY: "sk-ant",
      ANTHROPIC_BASE_URL: "https://gw.example/anthropic",
      OPENAI_API_KEY: "sk-oai",
      OPENAI_BASE_URL: "https://gw.example/openai",
      GOOGLE_API_KEY: "sk-goo",
      GOOGLE_BASE_URL: "https://gw.example/google",
    });
    expect(settings).toEqual({
      anthropicApiKey: "sk-ant",
      anthropicBaseUrl: "https://gw.example/anthropic",
      openaiApiKey: "sk-oai",
      openaiBaseUrl: "https://gw.example/openai",
      googleApiKey: "sk-goo",
      googleBaseUrl: "https://gw.example/google",
    });
  });

  it("accepts GEMINI_API_KEY as an alias, with GOOGLE_API_KEY winning", () => {
    expect(envSettings({ GEMINI_API_KEY: "sk-gem" }).googleApiKey).toBe("sk-gem");
    expect(envSettings({ GEMINI_API_KEY: "sk-gem", GOOGLE_API_KEY: "sk-goo" }).googleApiKey).toBe("sk-goo");
  });

  it("ignores empty-string env values", () => {
    expect(envSettings({ ANTHROPIC_API_KEY: "" })).toEqual({});
  });

  it("resolves CHAMFER_MODEL to a serialized model via the lookup", () => {
    const lookup = (provider: string) =>
      provider === "openai" ? [{ provider: "openai", id: "gpt-5", name: "GPT-5" }] : [];
    const settings = envSettings({ CHAMFER_MODEL: "gpt-5" }, lookup);
    expect(settings.modelJson).toBe(JSON.stringify({ provider: "openai", id: "gpt-5", name: "GPT-5" }));
  });

  it("uses CHAMFER_PROVIDER to disambiguate duplicate model ids", () => {
    const lookup = (provider: string) => [{ provider, id: "shared-id" }];
    const settings = envSettings({ CHAMFER_MODEL: "shared-id", CHAMFER_PROVIDER: "google" }, lookup);
    expect(settings.modelJson).toBe(JSON.stringify({ provider: "google", id: "shared-id" }));
  });

  it("omits modelJson when CHAMFER_MODEL matches nothing", () => {
    const settings = envSettings({ CHAMFER_MODEL: "no-such-model" }, () => []);
    expect(settings.modelJson).toBeUndefined();
  });

  it("resolves the fake model as the configured model in fake-LLM mode", () => {
    const settings = envSettings({
      CHAMFER_FAKE_LLM: "1",
      CHAMFER_MODEL: "chamfer-fake",
      CHAMFER_PROVIDER: "anthropic",
    }, () => []);

    expect(JSON.parse(settings.modelJson ?? "null")).toMatchObject({
      id: "chamfer-fake",
      provider: "anthropic",
    });
  });

  it("warns only once per distinct unknown CHAMFER_MODEL id", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    envSettings({ CHAMFER_MODEL: "missing-model-for-warning-dedupe" }, () => []);
    envSettings({ CHAMFER_MODEL: "missing-model-for-warning-dedupe" }, () => []);

    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("maps CHAMFER_MAX_CAD_RUNS to maxCadRuns", () => {
    expect(envSettings({ CHAMFER_MAX_CAD_RUNS: "25" }).maxCadRuns).toBe("25");
  });

  it("ignores CHAMFER_MAX_CAD_RUNS unless it is a positive integer", () => {
    expect(envSettings({ CHAMFER_MAX_CAD_RUNS: "abc" })).toEqual({});
    expect(envSettings({ CHAMFER_MAX_CAD_RUNS: "0" })).toEqual({});
    expect(envSettings({ CHAMFER_MAX_CAD_RUNS: "-3" })).toEqual({});
    expect(envSettings({ CHAMFER_MAX_CAD_RUNS: "2.5" })).toEqual({});
  });

  it("maps CHAMFER_SHOW_CAD_CODE=1 to showCadCode", () => {
    expect(envSettings({ CHAMFER_SHOW_CAD_CODE: "1" }).showCadCode).toBe("1");
  });

  it("maps the strict Fusion endpoint without enabling the experimental UI", () => {
    expect(envSettings({ CHAMFER_FUSION_MCP_ENDPOINT: "http://127.0.0.1:27182/mcp" })).toEqual({
      fusionMcpEndpoint: "http://127.0.0.1:27182/mcp",
    });
  });

  it("warns and ignores an unsafe Fusion endpoint", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(envSettings({ CHAMFER_FUSION_MCP_ENDPOINT: "https://example.com/mcp" })).toEqual({});
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("treats CHAMFER_SHOW_CAD_CODE=0 as unset without warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(envSettings({ CHAMFER_SHOW_CAD_CODE: "0" })).toEqual({});
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("warns and ignores CHAMFER_SHOW_CAD_CODE junk values", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(envSettings({ CHAMFER_SHOW_CAD_CODE: "yes" })).toEqual({});
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});
