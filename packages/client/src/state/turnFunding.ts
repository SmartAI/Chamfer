import {
  isLlmProvider,
  modelJsonProvider,
  PROVIDER_DISPLAY_NAMES,
  resolveTurnFunding,
  type HeadlessRuntimeCapabilitiesDto,
} from "@chamfer/shared";

/** Display-level turn funding for the composer gate and status bar (issue
 * #53). The decision itself is the shared resolveTurnFunding rule in
 * @chamfer/shared - the same one the hosted turn seed and title generation
 * consume - so this module only maps its verdict onto copy. */

/** The subset of GET /api/settings the funding verdict reads. Key values are
 * masked by the server; presence (non-empty) is all that matters here. */
export interface FundingSettings {
  modelJson?: string;
  anthropicApiKey?: string;
  openaiApiKey?: string;
  googleApiKey?: string;
}

export type FundingCapabilities = Pick<HeadlessRuntimeCapabilitiesDto, "demoQuota" | "demoModel">;

export interface TurnFunding {
  /** Display label of the model the next turn will actually run: the
   * Settings model when its provider is funded; on the fallback path, the
   * fallback model - marked "(demo)" only when the demo key truly pays (a
   * user key for the fallback provider makes it BYOK, unmarked). Falls back
   * to the selected model's label when nothing can fund it; null without
   * any model. */
  modelName: string | null;
  /** Display name of the provider whose missing Settings key blocks the
   * turn; null when the turn is fundable (or when no model is selected -
   * the settings-present gate owns that case). */
  missingProviderKey: string | null;
}

function modelLabel(modelJson: string | undefined): string | null {
  if (!modelJson) return null;
  try {
    const parsed = JSON.parse(modelJson) as { name?: unknown; id?: unknown };
    if (typeof parsed.name === "string" && parsed.name) return parsed.name;
    if (typeof parsed.id === "string" && parsed.id) return parsed.id;
  } catch {
    // A corrupt modelJson simply shows no model.
  }
  return null;
}

export function resolveTurnFundingDisplay(
  settings: FundingSettings,
  capabilities: FundingCapabilities,
): TurnFunding {
  const label = modelLabel(settings.modelJson);
  const demoModel = capabilities.demoQuota ? capabilities.demoModel : undefined;
  const verdict = resolveTurnFunding({
    selectedProvider: modelJsonProvider(settings.modelJson),
    keys: settings,
    fallbackProvider: demoModel && isLlmProvider(demoModel.provider) ? demoModel.provider : undefined,
  });
  switch (verdict.kind) {
    case "run":
      if (verdict.model === "selected") {
        return { modelName: label, missingProviderKey: null };
      }
      return {
        modelName: verdict.funding === "demo" ? `${demoModel!.name} (demo)` : demoModel!.name,
        missingProviderKey: null,
      };
    case "blocked":
      return { modelName: label, missingProviderKey: PROVIDER_DISPLAY_NAMES[verdict.missingProvider] };
    case "unroutable":
      return { modelName: label, missingProviderKey: verdict.provider };
    case "no-model":
      return { modelName: label, missingProviderKey: null };
  }
}
