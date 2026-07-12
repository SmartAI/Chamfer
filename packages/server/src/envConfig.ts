import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseEnv } from "node:util";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { Provider, SettingsDto } from "@chamfer/shared";

const DOTENV_FILES = [".env", ".env.local"] as const;
const ENV_PROVIDERS: Provider[] = ["anthropic", "openai", "google"];

type Env = Record<string, string | undefined>;
type ModelLookup = (provider: Provider) => ReadonlyArray<{ id: string }>;

export interface DotenvResult {
  /** Absolute paths of the dotenv files that were read, in load order. */
  files: string[];
}

/**
 * Loads .env and .env.local from the nearest directory at or above startDir
 * that contains either file. .env.local wins over .env; variables already
 * present in the target env (the real environment) are never overridden.
 */
export function loadDotenv(startDir = process.cwd(), env: Env = process.env): DotenvResult {
  let dir = startDir;
  for (;;) {
    if (DOTENV_FILES.some((name) => existsSync(join(dir, name)))) break;
    const parent = dirname(dir);
    if (parent === dir) return { files: [] };
    dir = parent;
  }

  const files: string[] = [];
  const fromFiles: Record<string, string> = {};
  for (const name of DOTENV_FILES) {
    const path = join(dir, name);
    if (!existsSync(path)) continue;
    Object.assign(fromFiles, parseEnv(readFileSync(path, "utf8")));
    files.push(path);
  }
  for (const [key, value] of Object.entries(fromFiles)) {
    if (!(key in env)) env[key] = value;
  }
  return { files };
}

function defaultModelLookup(provider: Provider): ReadonlyArray<{ id: string }> {
  return builtinModels().getModels(provider);
}

function resolveEnvModelJson(env: Env, lookup: ModelLookup): string | undefined {
  const modelId = env.CHAMFER_MODEL;
  if (!modelId) return undefined;
  const providers = ENV_PROVIDERS.includes(env.CHAMFER_PROVIDER as Provider)
    ? [env.CHAMFER_PROVIDER as Provider]
    : ENV_PROVIDERS;
  for (const provider of providers) {
    const model = lookup(provider).find((m) => m.id === modelId);
    if (model) return JSON.stringify(model);
  }
  console.warn(`CHAMFER_MODEL=${modelId} does not match any known model; ignoring`);
  return undefined;
}

/**
 * Derives the settings baseline from environment variables (typically loaded
 * from .env/.env.local by loadDotenv). Stored settings override these; see
 * readEffectiveSettings.
 */
export function envSettings(env: Env = process.env, lookup: ModelLookup = defaultModelLookup): SettingsDto {
  const settings: SettingsDto = {};
  const pick = (key: keyof SettingsDto, ...names: string[]) => {
    for (const name of names) {
      if (env[name]) {
        settings[key] = env[name];
        return;
      }
    }
  };
  pick("anthropicApiKey", "ANTHROPIC_API_KEY");
  pick("anthropicBaseUrl", "ANTHROPIC_BASE_URL");
  pick("openaiApiKey", "OPENAI_API_KEY");
  pick("openaiBaseUrl", "OPENAI_BASE_URL");
  pick("googleApiKey", "GOOGLE_API_KEY", "GEMINI_API_KEY");
  pick("googleBaseUrl", "GOOGLE_BASE_URL");
  const modelJson = resolveEnvModelJson(env, lookup);
  if (modelJson) settings.modelJson = modelJson;
  const maxCadRuns = env.CHAMFER_MAX_CAD_RUNS;
  if (maxCadRuns) {
    if (/^[1-9][0-9]*$/.test(maxCadRuns)) {
      settings.maxCadRuns = maxCadRuns;
    } else {
      console.warn(`CHAMFER_MAX_CAD_RUNS=${maxCadRuns} is not a positive integer; ignoring`);
    }
  }
  const showCadCode = env.CHAMFER_SHOW_CAD_CODE;
  if (showCadCode) {
    if (showCadCode === "1") {
      settings.showCadCode = "1";
    } else if (showCadCode !== "0") {
      console.warn(`CHAMFER_SHOW_CAD_CODE=${showCadCode} is not 1 or 0; ignoring (CAD code stays hidden)`);
    }
  }
  return settings;
}
