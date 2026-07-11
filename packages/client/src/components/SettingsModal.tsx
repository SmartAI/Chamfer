import { useEffect, useMemo, useState } from "react";
import type { ModelInfoDto, Provider, SettingsDto, SettingsSource, SettingsSources } from "@chamfer/shared";
import { getModels, getSettings, putSettings } from "@/api/rest";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const PROVIDER_LABELS: Record<Provider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
};

/** Free-text settings fields: per-provider credentials plus agent limits.
 * All ride the same diff-on-save / badge / reset machinery. */
interface ProviderFieldState {
  anthropicApiKey: string;
  anthropicBaseUrl: string;
  openaiApiKey: string;
  openaiBaseUrl: string;
  googleApiKey: string;
  googleBaseUrl: string;
  maxCadRuns: string;
}

const PROVIDERS: Provider[] = ["anthropic", "openai", "google"];
const PROVIDER_FIELDS: Array<keyof ProviderFieldState> = [
  "anthropicApiKey",
  "anthropicBaseUrl",
  "openaiApiKey",
  "openaiBaseUrl",
  "googleApiKey",
  "googleBaseUrl",
  "maxCadRuns",
];

function findCurrentModelId(settingsModelJson: string | undefined, models: ModelInfoDto[]): string | undefined {
  if (!settingsModelJson) return undefined;

  const byExactJson = models.find((m) => m.modelJson === settingsModelJson);
  if (byExactJson) return byExactJson.id;

  try {
    const parsed = JSON.parse(settingsModelJson) as { id?: string };
    if (parsed.id) {
      const byId = models.find((m) => m.id === parsed.id);
      if (byId) return byId.id;
    }
  } catch {
    // not valid JSON; no match
  }
  return undefined;
}

/** Provenance chip next to a field label: `.env` for environment-supplied
 * values, `saved` + a revert action for stored overrides shadowing an env
 * value. Hidden once the field is edited (the pending value is neither). */
function SourceBadge({ source, pristine, onReset }: { source?: SettingsSource; pristine: boolean; onReset: () => void }) {
  if (!pristine || !source || source === "db") return null;
  const chip = "rounded border border-border px-1 font-mono text-[10px] leading-4 text-muted-foreground";
  if (source === "env") return <span className={chip}>.env</span>;
  return (
    <span className="flex items-center gap-1.5">
      <span className={chip}>saved</span>
      <button
        type="button"
        className="text-[10px] text-muted-foreground underline hover:text-foreground"
        onClick={onReset}
      >
        Reset to .env
      </button>
    </span>
  );
}

function getModelBaseUrl(model: ModelInfoDto | undefined): string {
  if (!model) return "";
  try {
    return (JSON.parse(model.modelJson) as { baseUrl?: string }).baseUrl ?? "";
  } catch {
    return "";
  }
}

export interface SettingsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful save, before the modal closes (e.g. to re-fetch settings so
   * settings-gated UI enables without a reload). */
  onSaved?: () => void;
}

export function SettingsModal({ open, onOpenChange, onSaved }: SettingsModalProps) {
  const [loaded, setLoaded] = useState(false);
  const [initial, setInitial] = useState<SettingsDto>({});
  const [providerFields, setProviderFields] = useState<ProviderFieldState>({
    anthropicApiKey: "",
    anthropicBaseUrl: "",
    openaiApiKey: "",
    openaiBaseUrl: "",
    googleApiKey: "",
    googleBaseUrl: "",
    maxCadRuns: "",
  });
  const [models, setModels] = useState<ModelInfoDto[]>([]);
  const [sources, setSources] = useState<SettingsSources>({});
  const [selectedProvider, setSelectedProvider] = useState<Provider>("anthropic");
  const [selectedModelId, setSelectedModelId] = useState<string | undefined>(undefined);
  const [initialModelId, setInitialModelId] = useState<string | undefined>(undefined);
  const [reloadCount, setReloadCount] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(null);
    setLoaded(false);

    Promise.all([getSettings(), getModels()])
      .then(([settings, modelList]) => {
        if (cancelled) return;
        const defaultBaseUrl = (provider: Provider) =>
          getModelBaseUrl(modelList.find((model) => model.provider === provider));
        const loadedProviderFields: ProviderFieldState = {
          anthropicApiKey: settings.anthropicApiKey ?? "",
          anthropicBaseUrl: settings.anthropicBaseUrl || defaultBaseUrl("anthropic"),
          openaiApiKey: settings.openaiApiKey ?? "",
          openaiBaseUrl: settings.openaiBaseUrl || defaultBaseUrl("openai"),
          googleApiKey: settings.googleApiKey ?? "",
          googleBaseUrl: settings.googleBaseUrl || defaultBaseUrl("google"),
          maxCadRuns: settings.maxCadRuns ?? "",
        };
        setInitial({ ...settings, ...loadedProviderFields });
        setProviderFields(loadedProviderFields);
        setModels(modelList);
        setSources(settings.sources ?? {});
        const currentModelId = findCurrentModelId(settings.modelJson, modelList);
        const currentModel = modelList.find((model) => model.id === currentModelId);
        setSelectedProvider(currentModel?.provider ?? "anthropic");
        setSelectedModelId(currentModelId);
        setInitialModelId(currentModelId);
        setLoaded(true);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoaded(true);
      });

    return () => {
      cancelled = true;
    };
  }, [open, reloadCount]);

  const modelsByProvider = useMemo(() => {
    const groups = new Map<Provider, ModelInfoDto[]>();
    for (const model of models) {
      const list = groups.get(model.provider) ?? [];
      list.push(model);
      groups.set(model.provider, list);
    }
    return groups;
  }, [models]);

  const selectedModel = useMemo(
    () => models.find((m) => m.id === selectedModelId),
    [models, selectedModelId],
  );

  const providerModels = modelsByProvider.get(selectedProvider) ?? [];
  const apiKeyField = `${selectedProvider}ApiKey` as keyof ProviderFieldState;
  const baseUrlField = `${selectedProvider}BaseUrl` as keyof ProviderFieldState;

  function handleProviderChange(provider: Provider) {
    setSelectedProvider(provider);
    setSelectedModelId(modelsByProvider.get(provider)?.[0]?.id);
  }

  function handleProviderFieldChange(field: keyof ProviderFieldState, value: string) {
    setProviderFields((prev) => ({ ...prev, [field]: value }));
  }

  function isPristine(field: keyof ProviderFieldState): boolean {
    return providerFields[field] === (initial[field] ?? "");
  }

  /** Deletes a stored override so the key falls back to its env value, then
   * re-fetches so the field shows what it reverted to. */
  async function handleReset(field: keyof SettingsDto) {
    setError(null);
    try {
      await putSettings({ [field]: null });
      onSaved?.();
      setReloadCount((n) => n + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleSave() {
    setError(null);
    setSaving(true);
    try {
      const patch: SettingsDto = {};
      for (const field of PROVIDER_FIELDS) {
        if (providerFields[field] !== (initial[field] ?? "")) {
          patch[field] = providerFields[field];
        }
      }
      // Only persist the model when actually changed, so an env-sourced
      // model is not silently promoted to a stored override on every save.
      if (selectedModel && selectedModelId !== initialModelId) {
        patch.modelJson = selectedModel.modelJson;
      }
      await putSettings(patch);
      onSaved?.();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
        </DialogHeader>

        {loaded && (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="provider-select">Provider</Label>
              <Select value={selectedProvider} onValueChange={(value) => handleProviderChange(value as Provider)}>
                <SelectTrigger id="provider-select">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PROVIDERS.map((provider) => (
                    <SelectItem key={provider} value={provider}>
                      {PROVIDER_LABELS[provider]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <Label htmlFor="model-select">Model</Label>
                <SourceBadge
                  source={sources.modelJson}
                  pristine={selectedModelId === initialModelId}
                  onReset={() => void handleReset("modelJson")}
                />
              </div>
              <Select value={selectedModelId} onValueChange={setSelectedModelId}>
                <SelectTrigger id="model-select">
                  <SelectValue placeholder="Select a model" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectLabel>{PROVIDER_LABELS[selectedProvider]}</SelectLabel>
                    {providerModels.map((model) => (
                      <SelectItem key={model.id} value={model.id}>
                        {model.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <Label htmlFor="provider-api-key">API key</Label>
                <SourceBadge
                  source={sources[apiKeyField]}
                  pristine={isPristine(apiKeyField)}
                  onReset={() => void handleReset(apiKeyField)}
                />
              </div>
              <Input
                id="provider-api-key"
                type="password"
                autoComplete="off"
                value={providerFields[apiKeyField]}
                onChange={(event) => handleProviderFieldChange(apiKeyField, event.target.value)}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <Label htmlFor="provider-base-url">Base URL</Label>
                <SourceBadge
                  source={sources[baseUrlField]}
                  pristine={isPristine(baseUrlField)}
                  onReset={() => void handleReset(baseUrlField)}
                />
              </div>
              <Input
                id="provider-base-url"
                type="url"
                value={providerFields[baseUrlField]}
                onChange={(event) => handleProviderFieldChange(baseUrlField, event.target.value)}
              />
              <p className="text-xs text-muted-foreground">Change this only when using a compatible custom endpoint.</p>
            </div>

            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <Label htmlFor="max-cad-runs">Max CAD runs per turn</Label>
                <SourceBadge
                  source={sources.maxCadRuns}
                  pristine={isPristine("maxCadRuns")}
                  onReset={() => void handleReset("maxCadRuns")}
                />
              </div>
              <Input
                id="max-cad-runs"
                type="number"
                min={1}
                step={1}
                placeholder="10"
                value={providerFields.maxCadRuns}
                onChange={(event) => handleProviderFieldChange("maxCadRuns", event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Safety cap: the agent stops after this many build123d executions in one turn. Empty uses the default
                of 10.
              </p>
            </div>
          </div>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}

        <DialogFooter>
          <Button type="button" onClick={handleSave} disabled={saving || !loaded}>
            {saving ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
