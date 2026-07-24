import type { DatabaseSync } from "node:sqlite";
import { isLlmProvider, LLM_PROVIDERS, type Provider, type SettingsPatchDto } from "@chamfer/shared";
import { envSettings } from "../envConfig";
import { writeSettings } from "../settingsStore";

/**
 * LLM configuration for the hosted agent container (ADR 0003 key custody
 * rule): no LLM provider key ever enters a machine that executes CAD code.
 * The container's only LLM egress is the Worker proxy - the boot-time
 * CHAMFER_LLM_BASE_URL, then the per-turn delivered base URL - authenticated
 * by a short-lived conversation-scoped token that rides in place of the
 * provider API key. Any real provider credential found in the environment is
 * scrubbed before the agent slice boots.
 */

type Env = Record<string, string | undefined>;

/** Base-URL env vars that could reroute egress around the proxy; scrubbed
 * together with the credentials so the settings table stays the only source. */
const PROVIDER_BASE_URL_VARS = ["ANTHROPIC_BASE_URL", "OPENAI_BASE_URL", "GOOGLE_BASE_URL"];

/**
 * Credential env vars pi-ai actually falls back to at request time that the
 * generic *_API_KEY / *_OAUTH_TOKEN patterns below do not catch. Mirrored
 * from @earendil-works/pi-ai@0.81.1 dist/env-api-keys.js (getApiKeyEnvVars,
 * plus the google-vertex ADC and amazon-bedrock credential-chain probes in
 * getEnvApiKey); pi-ai does not export the list, so re-verify on pi
 * upgrades. AWS_SESSION_TOKEN is not on pi-ai's own probe list but completes
 * the AWS credential chain once the key pair exists.
 */
const EXTRA_CREDENTIAL_VARS = [
  "COPILOT_GITHUB_TOKEN",
  "HF_TOKEN",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "GCLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "AWS_PROFILE",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
];

/** Placeholder bearer for fake-LLM runs: the scripted stub ignores auth, but
 * pi-ai refuses to issue a request without some credential. */
const FAKE_LLM_TOKEN = "chamfer-fake-llm-token";

/**
 * Deletes every provider credential from the environment, in place, before
 * anything reads it (envSettings folds *_API_KEY vars into the settings
 * baseline, and pi-ai falls back to them at request time). Returns the
 * sorted names it removed so the entry can log the violation loudly. The
 * container's own CHAMFER_* configuration (notably CHAMFER_LLM_TOKEN) is
 * never scrubbed.
 */
export function scrubProviderCredentials(env: Env): string[] {
  const scrubbed: string[] = [];
  for (const name of Object.keys(env)) {
    if (name.startsWith("CHAMFER_")) continue;
    if (
      /_API_KEY$/.test(name) ||
      /_OAUTH_TOKEN$/.test(name) ||
      PROVIDER_BASE_URL_VARS.includes(name) ||
      EXTRA_CREDENTIAL_VARS.includes(name)
    ) {
      delete env[name];
      scrubbed.push(name);
    }
  }
  return scrubbed.sort();
}

export interface ContainerLlmConfig {
  /** Serialized pi-ai Model resolved from CHAMFER_MODEL. */
  modelJson: string;
  modelId: string;
  provider: Provider;
  /** Normalized proxy base URL; the model object carries it on every request. */
  baseUrl: string;
  /** Conversation-scoped bearer token, stored where the provider key would go. */
  token: string;
}

function providerOf(modelJson: string): { provider: Provider; id: string } {
  const parsed = JSON.parse(modelJson) as { provider?: unknown; id?: unknown };
  if (!isLlmProvider(parsed.provider)) {
    throw new Error(
      `model provider ${String(parsed.provider)} is not routable: hosted agent LLM egress supports ` +
        `${LLM_PROVIDERS.join(", ")} (one Worker proxy route per provider, #53)`,
    );
  }
  return { provider: parsed.provider, id: typeof parsed.id === "string" ? parsed.id : "unknown" };
}

/**
 * Trailing version-path segments that must not appear on a container-side
 * base URL, per provider (verified against @earendil-works/pi-ai@0.81.1;
 * the proxy documents the same facts from its side):
 * - anthropic: the Anthropic SDK appends /v1/messages itself, so a base
 *   configured with the conventional /v1 suffix would produce /v1/v1/....
 * - openai: the OpenAI SDK appends only /responses; the /v1 the real API
 *   needs lives in the PROXY's upstream base, so a /v1 here would double it
 *   at the upstream (/v1/v1/responses).
 * - google: pi-ai sets the SDK's apiVersion to "" and the /v1beta lives in
 *   the proxy's upstream base, so /v1beta (or /v1) here would double it too.
 */
const VERSION_SUFFIXES: Record<Provider, string[]> = {
  anthropic: ["/v1"],
  openai: ["/v1"],
  google: ["/v1beta", "/v1"],
};

function normalizeBaseUrl(provider: Provider, rawUrl: string): string {
  let url = rawUrl.replace(/\/+$/, "");
  for (const suffix of VERSION_SUFFIXES[provider]) {
    if (url.endsWith(suffix)) {
      url = url.slice(0, -suffix.length).replace(/\/+$/, "");
      console.warn(
        `container: stripped trailing ${suffix} from the ${provider} base URL - the version path ` +
          "belongs to the SDK or the proxy upstream, never the configured base (see config.ts)",
      );
      break;
    }
  }
  return url;
}

export function resolveContainerLlmConfig(env: Env = process.env): ContainerLlmConfig {
  const rawBaseUrl = env.CHAMFER_LLM_BASE_URL;
  if (!rawBaseUrl) {
    throw new Error(
      "CHAMFER_LLM_BASE_URL is required: the container reaches the LLM exclusively through the proxy (ADR 0003)",
    );
  }
  const fakeMode = env.CHAMFER_FAKE_LLM === "1";
  const token = env.CHAMFER_LLM_TOKEN ?? (fakeMode ? FAKE_LLM_TOKEN : undefined);
  if (!token) {
    throw new Error("CHAMFER_LLM_TOKEN is required: the proxy authenticates each conversation with its own token");
  }
  const { modelJson } = envSettings(env);
  if (!modelJson) {
    throw new Error("CHAMFER_MODEL did not resolve to a known model; set CHAMFER_MODEL (and CHAMFER_PROVIDER)");
  }
  const { provider, id } = providerOf(modelJson);
  return { modelJson, modelId: id, provider, baseUrl: normalizeBaseUrl(provider, rawBaseUrl), token };
}

/**
 * Persists the LLM routing into the scratch settings table, which outranks
 * every env var (db > env precedence in readEffectiveSettings): the session
 * host then resolves the proxy URL and token through the exact same
 * resolveProviderConfig path a locally configured key takes.
 */
export function applyContainerLlmSettings(db: DatabaseSync, config: ContainerLlmConfig): void {
  const patch: SettingsPatchDto = {
    modelJson: config.modelJson,
    [`${config.provider}BaseUrl`]: config.baseUrl,
    [`${config.provider}ApiKey`]: config.token,
  };
  writeSettings(db, patch);
}

/** One turn's LLM routing, handed over in the seed request (issues #51/#53):
 * the model the turn runs (serialized pi-ai Model plus its provider), that
 * conversation's provider proxy base URL (it embeds the conversation id), and
 * a fresh short-lived token minted for exactly this turn. modelJson/provider
 * are optional so a boot-time-only delivery (tests, older callers) still
 * refreshes the anthropic routing. */
export interface ContainerLlmDelivery {
  baseUrl: string;
  token: string;
  modelJson?: string;
  provider?: Provider;
}

/**
 * Overwrites the turn-scoped half of the LLM settings. All values are
 * conversation-scoped while the settings table is container-global - that is
 * the reason turns serialize per container: what is written here must stay
 * current until the turn's last LLM request. A delivered modelJson replaces
 * the boot-time model (the session host rebuilds or switches its live pi
 * session from it); the same per-provider version-suffix normalization as
 * boot applies to the base URL.
 */
export function applyTurnLlmDelivery(db: DatabaseSync, delivery: ContainerLlmDelivery): void {
  const provider = delivery.provider ?? "anthropic";
  if (delivery.modelJson !== undefined && providerOf(delivery.modelJson).provider !== provider) {
    throw new Error("delivered modelJson's provider does not match the delivered provider");
  }
  const patch: SettingsPatchDto = {
    [`${provider}BaseUrl`]: normalizeBaseUrl(provider, delivery.baseUrl),
    [`${provider}ApiKey`]: delivery.token,
    ...(delivery.modelJson !== undefined ? { modelJson: delivery.modelJson } : {}),
  };
  writeSettings(db, patch);
}
