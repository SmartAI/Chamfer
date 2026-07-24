import { describe, expect, it } from "vitest";
import { resolveTurnFundingDisplay } from "./turnFunding";

const GEMINI = JSON.stringify({ provider: "google", id: "gemini-3.5-flash", name: "Gemini 3.5 Flash" });
const CLAUDE = JSON.stringify({ provider: "anthropic", id: "claude-sonnet-5", name: "Claude Sonnet 5" });
const GPT = JSON.stringify({ provider: "openai", id: "gpt-5.4-mini", name: "GPT-5.4 mini" });

const DEMO = {
  demoQuota: true,
  demoModel: { id: "claude-sonnet-5", name: "Claude Sonnet 5", provider: "anthropic" as const },
};
const NO_DEMO = { demoQuota: false };

// Display mapping over the shared funding rule (resolveTurnFunding in
// @chamfer/shared) - the same rule the hosted turn seed and title generation
// consume, so the surfaces cannot drift.
describe("resolveTurnFundingDisplay", () => {
  it("runs the settings model when its provider has a key (masked values count)", () => {
    expect(resolveTurnFundingDisplay({ modelJson: GEMINI, googleApiKey: "***abcd" }, NO_DEMO)).toEqual({
      modelName: "Gemini 3.5 Flash",
      missingProviderKey: null,
    });
    expect(resolveTurnFundingDisplay({ modelJson: GPT, openaiApiKey: "***abcd" }, NO_DEMO)).toEqual({
      modelName: "GPT-5.4 mini",
      missingProviderKey: null,
    });
  });

  it("labels the demo pin only when the demo key truly pays", () => {
    expect(resolveTurnFundingDisplay({ modelJson: GEMINI }, DEMO)).toEqual({
      modelName: "Claude Sonnet 5 (demo)",
      missingProviderKey: null,
    });
  });

  it("drops the (demo) marker when the user's own key funds the fallback (BYOK)", () => {
    // Key-first resolution at the proxy: a user with an Anthropic key pays
    // for the fallback model themselves, unmetered - "(demo)" would lie.
    expect(resolveTurnFundingDisplay({ modelJson: GEMINI, anthropicApiKey: "***abcd" }, DEMO)).toEqual({
      modelName: "Claude Sonnet 5",
      missingProviderKey: null,
    });
  });

  it("labels the demo pin for a fresh account on the demo default", () => {
    expect(resolveTurnFundingDisplay({ modelJson: CLAUDE }, DEMO)).toEqual({
      modelName: "Claude Sonnet 5 (demo)",
      missingProviderKey: null,
    });
  });

  it("closes the gate naming the provider when nothing can fund the turn", () => {
    expect(resolveTurnFundingDisplay({ modelJson: GEMINI }, NO_DEMO)).toEqual({
      modelName: "Gemini 3.5 Flash",
      missingProviderKey: "Google",
    });
    expect(resolveTurnFundingDisplay({ modelJson: CLAUDE }, NO_DEMO).missingProviderKey).toBe("Anthropic");
    // Another provider's key does not fund the selection without a fallback.
    expect(
      resolveTurnFundingDisplay({ modelJson: GEMINI, anthropicApiKey: "***abcd" }, NO_DEMO).missingProviderKey,
    ).toBe("Google");
  });

  it("a masked-empty key value does not count as a key", () => {
    expect(resolveTurnFundingDisplay({ modelJson: GEMINI, googleApiKey: "" }, NO_DEMO).missingProviderKey).toBe(
      "Google",
    );
  });

  it("leaves the no-model case to the settings-present gate", () => {
    expect(resolveTurnFundingDisplay({}, NO_DEMO)).toEqual({ modelName: null, missingProviderKey: null });
  });
});
