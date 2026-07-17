import { describe, expect, it } from "vitest";
import type { EvaluationIdentities } from "./identity";
import {
  parseEvaluationResult,
  renderEvaluationMarkdown,
  serializeEvaluationResult,
} from "./result";

const hash = `sha256:${"a".repeat(64)}`;
const identities: EvaluationIdentities = {
  corpus: { id: "tracer", version: 1, hash },
  case: {
    id: "text.precise-box",
    version: 1,
    hash,
    purpose: "Fixture",
    modality: "text",
    complexity: "smoke",
    categories: ["construction"],
    gatingStatus: "release",
  },
  assets: [],
  agentConfiguration: {
    hash,
    productRelease: "0.2.1",
    gitCommit: "fixture-commit",
    dirty: false,
    promptHash: hash,
    skillHash: hash,
    policyHash: hash,
    toolsetHash: hash,
    provider: "anthropic",
    model: "fixture-model",
    inferenceSettingsHash: hash,
  },
  evaluators: [
    { id: "verification-gate", version: 1, required: true, hash },
    { id: "bbox", version: 1, required: true, hash },
  ],
  rubrics: [],
  runner: { version: 1, hash },
  environment: {
    hash,
    node: "26.4.0",
    browser: "chromium",
    operatingSystem: "darwin",
    architecture: "arm64",
    productBuildHash: hash,
  },
  repetition: { index: 1, hash },
};

const result = {
  schemaVersion: 1 as const,
  identities,
  evidenceClass: "infrastructure" as const,
  execution: {
    state: "completed" as const,
    startedAt: "2026-07-13T07:00:00.000Z",
    finishedAt: "2026-07-13T07:00:21.000Z",
    durationMs: 21_000,
  },
  outcome: { kind: "completed" as const, expectedMatch: true },
  evidence: [
    { id: "conversation", kind: "conversation", reference: "conversation:fixture" },
    { id: "artifact", kind: "cad-artifact", reference: "artifact:fixture:1" },
  ],
  measurements: {
    gatePassed: true,
    bodyCount: 1,
    boundingBoxMm: [10, 20, 30] as [number, number, number],
    cadRuns: 1,
    modelCalls: 2,
    toolCalls: 1,
    toolErrors: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    providerCost: 0,
  },
  scores: [
    {
      id: "verification-gate",
      evaluatorVersion: 1,
      status: "passed" as const,
      required: true,
      value: 1,
      evidenceIds: ["conversation"],
    },
    {
      id: "bbox",
      evaluatorVersion: 1,
      status: "passed" as const,
      required: true,
      value: 1,
      evidenceIds: ["artifact"],
    },
  ],
  proficiency: {
    included: false,
    exclusionReason: "Scripted execution is infrastructure evidence.",
  },
  integrity: { violations: [] },
};

describe("evaluation result output", () => {
  it("serializes a versioned machine-readable result without changing its model", () => {
    const parsed = parseEvaluationResult(result);
    const serialized = serializeEvaluationResult(parsed);

    expect(JSON.parse(serialized)).toEqual(result);
    expect(serialized.endsWith("\n")).toBe(true);
  });

  it("derives the Markdown report from the same result model", () => {
    const markdown = renderEvaluationMarkdown(parseEvaluationResult(result));

    expect(markdown).toContain("# Evaluation: text.precise-box v1");
    expect(markdown).toContain("| Execution | completed |");
    expect(markdown).toContain("| Expected outcome matched | yes |");
    expect(markdown).toContain("| verification-gate v1 | passed | required |");
    expect(markdown).toContain("Scripted execution is infrastructure evidence.");
  });

  it("rejects scripted evidence that enters the proficiency denominator", () => {
    expect(() => parseEvaluationResult({
      ...result,
      proficiency: { included: true },
    })).toThrow(/infrastructure evidence/i);
  });
});
