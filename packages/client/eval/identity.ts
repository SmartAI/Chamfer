import { createHash } from "node:crypto";
import type { EvaluationCase } from "./schema";

type CanonicalValue = null | boolean | number | string | CanonicalValue[] | {
  [key: string]: CanonicalValue;
};

export interface AgentConfigurationIdentityInput {
  productRelease: string;
  gitCommit: string;
  dirty: boolean;
  promptHash: string;
  skillHash: string;
  policyHash: string;
  toolsetHash: string;
  provider: string;
  model: string;
  inferenceSettings: Record<string, unknown>;
}

export interface VersionedDefinition {
  id: string;
  version: number;
  required: boolean;
  sourceHash: string;
  config?: Record<string, unknown>;
}

export interface EvaluationIdentityInput {
  corpus: { id: string; version: number; cases: EvaluationCase[] };
  evaluationCase: EvaluationCase;
  agentConfiguration: AgentConfigurationIdentityInput;
  evaluatorDefinitions: VersionedDefinition[];
  rubricDefinitions: VersionedDefinition[];
  runner: { version: number; sourceHash: string };
  environment: {
    node: string;
    browser: string;
    operatingSystem: string;
    architecture: string;
    productBuildHash: string;
  };
  repetition: { index: number; seed: number; depth: "scripted" | "targeted" | "release" };
}

export interface EvaluationIdentities {
  corpus: { id: string; version: number; hash: string };
  case: {
    id: string;
    version: number;
    hash: string;
    purpose: string;
    modality: EvaluationCase["modality"];
    complexity: EvaluationCase["complexity"];
    categories: string[];
    gatingStatus: EvaluationCase["gatingStatus"];
  };
  assets: Array<{ id: string; hash: string }>;
  agentConfiguration: {
    hash: string;
    productRelease: string;
    gitCommit: string;
    dirty: boolean;
    promptHash: string;
    skillHash: string;
    policyHash: string;
    toolsetHash: string;
    provider: string;
    model: string;
    inferenceSettingsHash: string;
  };
  evaluators: Array<{ id: string; version: number; required: boolean; hash: string }>;
  rubrics: Array<{ id: string; version: number; required: boolean; hash: string }>;
  runner: { version: number; hash: string };
  environment: {
    hash: string;
    node: string;
    browser: string;
    operatingSystem: string;
    architecture: string;
    productBuildHash: string;
  };
  repetition: { index: number; hash: string };
}

function canonicalValue(value: unknown, path: string): CanonicalValue {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return value.normalize("NFC").replace(/\r\n?/g, "\n");
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`Cannot hash non-finite number at ${path}`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => canonicalValue(item, `${path}[${index}]`));
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right));
    const result: Record<string, CanonicalValue> = {};
    for (const [key, item] of entries) {
      if (item === undefined) throw new Error(`Cannot hash undefined value at ${path}.${key}`);
      result[key.normalize("NFC")] = canonicalValue(item, `${path}.${key}`);
    }
    return result;
  }
  throw new Error(`Cannot hash ${typeof value} value at ${path}`);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value, "root"));
}

export function sha256Identity(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function requireText(value: string, path: string): void {
  if (!value.trim()) throw new Error(`Unresolved required identity: ${path}`);
}

function requireVersion(value: number, path: string): void {
  if (!Number.isInteger(value) || value < 1) throw new Error(`Unresolved required identity: ${path}`);
}

function validateIdentityInput(input: EvaluationIdentityInput): void {
  requireText(input.corpus.id, "corpus.id");
  requireVersion(input.corpus.version, "corpus.version");
  if (input.corpus.cases.length === 0) throw new Error("Unresolved required identity: corpus.cases");
  if (!input.corpus.cases.some((candidate) =>
    candidate.id === input.evaluationCase.id && candidate.version === input.evaluationCase.version
  )) {
    throw new Error("Unresolved required identity: evaluationCase is absent from corpus");
  }

  const configuration = input.agentConfiguration;
  for (const [field, value] of Object.entries(configuration)) {
    if (field === "dirty" || field === "inferenceSettings") continue;
    requireText(value as string, `agentConfiguration.${field}`);
  }

  const evaluatorDefinitions = new Map(input.evaluatorDefinitions.map((definition) => [definition.id, definition]));
  for (const reference of input.evaluationCase.evaluatorRefs) {
    const definition = evaluatorDefinitions.get(reference.id);
    if (!definition || definition.version !== reference.version) {
      throw new Error(`Unresolved required identity: evaluator ${reference.id}@${reference.version}`);
    }
  }
  const rubricDefinitions = new Map(input.rubricDefinitions.map((definition) => [definition.id, definition]));
  for (const reference of input.evaluationCase.rubricRefs) {
    const definition = rubricDefinitions.get(reference.id);
    if (!definition || definition.version !== reference.version) {
      throw new Error(`Unresolved required identity: rubric ${reference.id}@${reference.version}`);
    }
  }
  for (const [index, definition] of [...input.evaluatorDefinitions, ...input.rubricDefinitions].entries()) {
    requireText(definition.id, `definition[${index}].id`);
    requireVersion(definition.version, `definition[${index}].version`);
    requireText(definition.sourceHash, `definition[${index}].sourceHash`);
  }

  requireVersion(input.runner.version, "runner.version");
  requireText(input.runner.sourceHash, "runner.sourceHash");
  for (const [field, value] of Object.entries(input.environment)) {
    requireText(value, `environment.${field}`);
  }
  requireVersion(input.repetition.index, "repetition.index");
  if (!Number.isInteger(input.repetition.seed) || input.repetition.seed < 0) {
    throw new Error("Unresolved required identity: repetition.seed");
  }
}

export function createEvaluationIdentities(input: EvaluationIdentityInput): EvaluationIdentities {
  validateIdentityInput(input);
  return {
    corpus: {
      id: input.corpus.id,
      version: input.corpus.version,
      hash: sha256Identity(input.corpus),
    },
    case: {
      id: input.evaluationCase.id,
      version: input.evaluationCase.version,
      hash: sha256Identity(input.evaluationCase),
      purpose: input.evaluationCase.purpose,
      modality: input.evaluationCase.modality,
      complexity: input.evaluationCase.complexity,
      categories: input.evaluationCase.categories,
      gatingStatus: input.evaluationCase.gatingStatus,
    },
    assets: input.evaluationCase.inputs.assets.map((asset) => ({
      id: asset.id,
      hash: sha256Identity(asset),
    })),
    agentConfiguration: {
      hash: sha256Identity(input.agentConfiguration),
      productRelease: input.agentConfiguration.productRelease,
      gitCommit: input.agentConfiguration.gitCommit,
      dirty: input.agentConfiguration.dirty,
      promptHash: input.agentConfiguration.promptHash,
      skillHash: input.agentConfiguration.skillHash,
      policyHash: input.agentConfiguration.policyHash,
      toolsetHash: input.agentConfiguration.toolsetHash,
      provider: input.agentConfiguration.provider,
      model: input.agentConfiguration.model,
      inferenceSettingsHash: sha256Identity(input.agentConfiguration.inferenceSettings),
    },
    evaluators: input.evaluatorDefinitions.map((definition) => ({
      id: definition.id,
      version: definition.version,
      required: definition.required,
      hash: sha256Identity(definition),
    })),
    rubrics: input.rubricDefinitions.map((definition) => ({
      id: definition.id,
      version: definition.version,
      required: definition.required,
      hash: sha256Identity(definition),
    })),
    runner: { version: input.runner.version, hash: sha256Identity(input.runner) },
    environment: { hash: sha256Identity(input.environment), ...input.environment },
    repetition: { index: input.repetition.index, hash: sha256Identity(input.repetition) },
  };
}
