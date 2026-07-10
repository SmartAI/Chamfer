import type { SettingsDto } from "@chamfer/shared";

type ConfigurableProvider = "anthropic" | "openai" | "google";

function isConfigurableProvider(value: unknown): value is ConfigurableProvider {
  return value === "anthropic" || value === "openai" || value === "google";
}

export interface ResolvedProviderConfig {
  /** The model with any settings-level baseUrl override applied. */
  requestModel: unknown;
  apiKey: string | undefined;
  env: Record<string, string>;
}

/**
 * Resolves the per-provider apiKey/baseUrl/env for an LLM call from stored
 * settings. Shared by the /api/stream proxy and server-initiated calls
 * (conversation title generation).
 */
export function resolveProviderConfig(settings: SettingsDto, model: unknown): ResolvedProviderConfig {
  const provider =
    typeof model === "object" && model !== null && isConfigurableProvider((model as { provider?: unknown }).provider)
      ? (model as { provider: ConfigurableProvider }).provider
      : undefined;
  const apiKey = provider ? settings[`${provider}ApiKey`] : undefined;
  const baseUrl = provider ? settings[`${provider}BaseUrl`] : undefined;
  const requestModel = baseUrl && typeof model === "object" && model !== null ? { ...model, baseUrl } : model;
  const env: Record<string, string> = {};
  if (settings.anthropicApiKey) env.ANTHROPIC_API_KEY = settings.anthropicApiKey;
  if (settings.openaiApiKey) env.OPENAI_API_KEY = settings.openaiApiKey;
  if (settings.googleApiKey) {
    env.GEMINI_API_KEY = settings.googleApiKey;
    env.GOOGLE_API_KEY = settings.googleApiKey;
  }
  return { requestModel, apiKey, env };
}
