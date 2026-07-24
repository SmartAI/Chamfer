import { describe, expect, it, vi } from "vitest";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { openDb } from "../db";
import { readEffectiveSettings } from "../settingsStore";
import {
  applyContainerLlmSettings,
  applyTurnLlmDelivery,
  resolveContainerLlmConfig,
  scrubProviderCredentials,
} from "./config";

const STUB_URL = "http://127.0.0.1:9999";

function fakeEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    CHAMFER_FAKE_LLM: "1",
    CHAMFER_MODEL: "chamfer-fake",
    CHAMFER_LLM_BASE_URL: STUB_URL,
    ...overrides,
  };
}

describe("scrubProviderCredentials", () => {
  it("removes provider keys, OAuth tokens, and provider base URLs but keeps container config", () => {
    const env: Record<string, string | undefined> = {
      ANTHROPIC_API_KEY: "sk-real",
      ANTHROPIC_OAUTH_TOKEN: "oauth",
      OPENAI_API_KEY: "sk-openai",
      GOOGLE_API_KEY: "g",
      GEMINI_API_KEY: "g2",
      ANTHROPIC_BASE_URL: "https://api.anthropic.com",
      OPENAI_BASE_URL: "https://api.openai.com/v1",
      GOOGLE_BASE_URL: "https://x",
      CHAMFER_LLM_BASE_URL: STUB_URL,
      CHAMFER_LLM_TOKEN: "conversation-token",
      CHAMFER_MODEL: "chamfer-fake",
      PATH: "/usr/local/bin",
    };
    const scrubbed = scrubProviderCredentials(env);
    expect(scrubbed).toEqual([
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_OAUTH_TOKEN",
      "GEMINI_API_KEY",
      "GOOGLE_API_KEY",
      "GOOGLE_BASE_URL",
      "OPENAI_API_KEY",
      "OPENAI_BASE_URL",
    ]);
    for (const name of scrubbed) expect(env[name]).toBeUndefined();
    expect(env.CHAMFER_LLM_BASE_URL).toBe(STUB_URL);
    expect(env.CHAMFER_LLM_TOKEN).toBe("conversation-token");
    expect(env.PATH).toBe("/usr/local/bin");
  });

  it("covers pi-ai's pattern-defying fallback credentials: copilot, huggingface, ADC, bedrock", () => {
    const env: Record<string, string | undefined> = {
      COPILOT_GITHUB_TOKEN: "ghu_x",
      HF_TOKEN: "hf_x",
      GOOGLE_APPLICATION_CREDENTIALS: "/creds.json",
      GOOGLE_CLOUD_PROJECT: "p",
      AWS_PROFILE: "default",
      AWS_ACCESS_KEY_ID: "AKIA",
      AWS_SECRET_ACCESS_KEY: "secret",
      AWS_SESSION_TOKEN: "session",
      AWS_BEARER_TOKEN_BEDROCK: "bearer",
      AWS_WEB_IDENTITY_TOKEN_FILE: "/token",
      CHAMFER_LLM_TOKEN: "conversation-token",
    };
    const scrubbed = scrubProviderCredentials(env);
    expect(scrubbed).toContain("COPILOT_GITHUB_TOKEN");
    expect(scrubbed).toContain("HF_TOKEN");
    expect(scrubbed).toContain("GOOGLE_APPLICATION_CREDENTIALS");
    expect(scrubbed).toContain("AWS_ACCESS_KEY_ID");
    expect(scrubbed).toContain("AWS_BEARER_TOKEN_BEDROCK");
    expect(scrubbed).toContain("AWS_WEB_IDENTITY_TOKEN_FILE");
    for (const name of scrubbed) expect(env[name]).toBeUndefined();
    expect(env.CHAMFER_LLM_TOKEN).toBe("conversation-token");
  });

  it("returns an empty list when nothing needs scrubbing", () => {
    const env = fakeEnv();
    expect(scrubProviderCredentials(env)).toEqual([]);
  });
});

describe("resolveContainerLlmConfig", () => {
  it("resolves the fake model with a default token in fake mode", () => {
    const config = resolveContainerLlmConfig(fakeEnv());
    expect(config.provider).toBe("anthropic");
    expect(config.modelId).toBe("chamfer-fake");
    expect(config.baseUrl).toBe(STUB_URL);
    expect(config.token).not.toBe("");
    expect(JSON.parse(config.modelJson)).toMatchObject({ id: "chamfer-fake", provider: "anthropic" });
  });

  it("prefers an explicit CHAMFER_LLM_TOKEN over the fake default", () => {
    const config = resolveContainerLlmConfig(fakeEnv({ CHAMFER_LLM_TOKEN: "explicit" }));
    expect(config.token).toBe("explicit");
  });

  it("strips a trailing /v1 from an anthropic base URL with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const config = resolveContainerLlmConfig(fakeEnv({ CHAMFER_LLM_BASE_URL: "https://proxy.example/llm/v1/" }));
      expect(config.baseUrl).toBe("https://proxy.example/llm");
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });

  it("requires CHAMFER_LLM_BASE_URL", () => {
    expect(() => resolveContainerLlmConfig(fakeEnv({ CHAMFER_LLM_BASE_URL: undefined })))
      .toThrow(/CHAMFER_LLM_BASE_URL/);
  });

  it("requires CHAMFER_LLM_TOKEN outside fake mode", () => {
    expect(() => resolveContainerLlmConfig(fakeEnv({ CHAMFER_FAKE_LLM: undefined, CHAMFER_MODEL: "chamfer-fake" })))
      .toThrow(/CHAMFER_LLM_TOKEN/);
  });

  it("requires a resolvable CHAMFER_MODEL", () => {
    expect(() => resolveContainerLlmConfig(fakeEnv({ CHAMFER_MODEL: undefined, CHAMFER_LLM_TOKEN: "t" })))
      .toThrow(/CHAMFER_MODEL/);
  });

  it("resolves models from every proxied provider (issue #53 widening)", () => {
    for (const provider of ["openai", "google"] as const) {
      const model = builtinModels().getModels(provider)[0];
      expect(model).toBeDefined();
      const config = resolveContainerLlmConfig(fakeEnv({
        CHAMFER_MODEL: model!.id,
        CHAMFER_PROVIDER: provider,
        CHAMFER_LLM_TOKEN: "t",
      }));
      expect(config.provider).toBe(provider);
      expect(config.modelId).toBe(model!.id);
    }
  });
});

describe("applyContainerLlmSettings", () => {
  it("writes model, base URL, and token so the session host resolves them from the store", () => {
    const db = openDb(":memory:");
    const config = resolveContainerLlmConfig(fakeEnv({ CHAMFER_LLM_TOKEN: "conversation-token" }));
    applyContainerLlmSettings(db, config);
    // Empty env: everything must come from the settings table.
    const { settings, sources } = readEffectiveSettings(db, {});
    expect(settings.anthropicBaseUrl).toBe(STUB_URL);
    expect(settings.anthropicApiKey).toBe("conversation-token");
    expect(JSON.parse(settings.modelJson ?? "{}")).toMatchObject({ id: "chamfer-fake" });
    expect(sources.anthropicBaseUrl).toBe("db");
  });
});

describe("applyTurnLlmDelivery", () => {
  it("overwrites base URL and token per turn while leaving the boot model alone", () => {
    const db = openDb(":memory:");
    applyContainerLlmSettings(db, resolveContainerLlmConfig(fakeEnv({ CHAMFER_LLM_TOKEN: "boot-placeholder" })));
    applyTurnLlmDelivery(db, {
      baseUrl: "https://app.example/api/llm/anthropic/conv-1",
      token: "turn-token-1",
    });
    const { settings } = readEffectiveSettings(db, {});
    expect(settings.anthropicBaseUrl).toBe("https://app.example/api/llm/anthropic/conv-1");
    expect(settings.anthropicApiKey).toBe("turn-token-1");
    expect(JSON.parse(settings.modelJson ?? "{}")).toMatchObject({ id: "chamfer-fake" });

    // The next turn's delivery replaces both values again.
    applyTurnLlmDelivery(db, {
      baseUrl: "https://app.example/api/llm/anthropic/conv-2",
      token: "turn-token-2",
    });
    const next = readEffectiveSettings(db, {}).settings;
    expect(next.anthropicBaseUrl).toBe("https://app.example/api/llm/anthropic/conv-2");
    expect(next.anthropicApiKey).toBe("turn-token-2");
  });

  it("applies the same /v1 normalization as boot", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const db = openDb(":memory:");
      applyTurnLlmDelivery(db, { baseUrl: "https://app.example/api/llm/anthropic/conv-1/v1/", token: "t" });
      expect(readEffectiveSettings(db, {}).settings.anthropicBaseUrl).toBe(
        "https://app.example/api/llm/anthropic/conv-1",
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("writes a delivered model and its provider's routing (issue #53)", () => {
    const db = openDb(":memory:");
    applyContainerLlmSettings(db, resolveContainerLlmConfig(fakeEnv({ CHAMFER_LLM_TOKEN: "boot" })));
    const gemini = JSON.stringify({ provider: "google", id: "gemini-test" });
    applyTurnLlmDelivery(db, {
      baseUrl: "https://app.example/api/llm/google/conv-1",
      token: "turn-token",
      modelJson: gemini,
      provider: "google",
    });
    const { settings } = readEffectiveSettings(db, {});
    expect(settings.googleBaseUrl).toBe("https://app.example/api/llm/google/conv-1");
    expect(settings.googleApiKey).toBe("turn-token");
    expect(settings.modelJson).toBe(gemini);
    // The boot-time anthropic routing stays in place for a later fallback turn.
    expect(settings.anthropicApiKey).toBe("boot");
  });

  it("strips each provider's version-path suffix from a delivered base URL", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const db = openDb(":memory:");
      const openaiModel = JSON.stringify({ provider: "openai", id: "gpt-test" });
      // The OpenAI SDK appends /responses straight to the base; the /v1 the
      // upstream needs lives in the proxy, so a delivered /v1 would double it.
      applyTurnLlmDelivery(db, {
        baseUrl: "https://app.example/api/llm/openai/conv-1/v1",
        token: "t",
        modelJson: openaiModel,
        provider: "openai",
      });
      expect(readEffectiveSettings(db, {}).settings.openaiBaseUrl).toBe(
        "https://app.example/api/llm/openai/conv-1",
      );
      const gemini = JSON.stringify({ provider: "google", id: "gemini-test" });
      // Same for google's /v1beta: pi-ai sets the SDK's apiVersion to "".
      applyTurnLlmDelivery(db, {
        baseUrl: "https://app.example/api/llm/google/conv-1/v1beta/",
        token: "t",
        modelJson: gemini,
        provider: "google",
      });
      expect(readEffectiveSettings(db, {}).settings.googleBaseUrl).toBe(
        "https://app.example/api/llm/google/conv-1",
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("rejects a delivery whose modelJson contradicts its provider", () => {
    const db = openDb(":memory:");
    expect(() =>
      applyTurnLlmDelivery(db, {
        baseUrl: "https://app.example/api/llm/google/conv-1",
        token: "t",
        modelJson: JSON.stringify({ provider: "openai", id: "gpt-test" }),
        provider: "google",
      }),
    ).toThrow(/does not match/);
  });
});
