import { describe, expect, it } from "vitest";
import type { EvaluationResult } from "./result";
import { calculateCohortVerdict, classifyOutcome } from "./verdict";

const hash = `sha256:${"b".repeat(64)}`;

function result(overrides: Partial<EvaluationResult> = {}): EvaluationResult {
  return {
    schemaVersion: 1,
    identities: {
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
      evaluators: [{ id: "verification-gate", version: 1, required: true, hash }],
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
    },
    evidenceClass: "proficiency",
    execution: {
      state: "completed",
      startedAt: "2026-07-13T07:00:00.000Z",
      finishedAt: "2026-07-13T07:00:10.000Z",
      durationMs: 10_000,
    },
    outcome: { kind: "completed", expectedMatch: true },
    evidence: [{ id: "conversation", kind: "conversation", reference: "conversation:fixture" }],
    measurements: {
      cadRuns: 1,
      modelCalls: 2,
      toolCalls: 1,
      toolErrors: 0,
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      providerCost: 10,
    },
    scores: [{
      id: "verification-gate",
      evaluatorVersion: 1,
      status: "passed",
      required: true,
      value: 1,
      evidenceIds: ["conversation"],
    }],
    proficiency: { included: true },
    integrity: { violations: [] },
    ...overrides,
  };
}

describe("ordered cohort verdict", () => {
  it("fails a false success at integrity even when cost and latency improve", () => {
    const falseSuccess = result({
      execution: {
        state: "completed",
        startedAt: "2026-07-13T07:00:00.000Z",
        finishedAt: "2026-07-13T07:00:01.000Z",
        durationMs: 1_000,
      },
      measurements: { ...result().measurements, providerCost: 0.01 },
      scores: [{
        id: "verification-gate",
        evaluatorVersion: 1,
        status: "failed",
        required: true,
        value: 0,
        evidenceIds: ["conversation"],
      }],
    });

    const verdict = calculateCohortVerdict({
      results: [falseSuccess],
      requiredAttempts: [{ caseId: "text.precise-box", caseVersion: 1, repetition: 1 }],
      privacy: { status: "passed", findings: [] },
    });

    expect(verdict).toMatchObject({ status: "failed", passes: false, decidingLayer: "integrity" });
    expect(verdict.layers.integrity.violations.map((violation) => violation.kind)).toContain("false-success");
    expect(verdict.layers.efficiency.status).toBe("not-evaluated");
  });

  it("fails closed when a required attempt is missing", () => {
    const verdict = calculateCohortVerdict({
      results: [result()],
      requiredAttempts: [
        { caseId: "text.precise-box", caseVersion: 1, repetition: 1 },
        { caseId: "text.precise-box", caseVersion: 1, repetition: 2 },
      ],
      privacy: { status: "passed", findings: [] },
    });

    expect(verdict).toMatchObject({ status: "incomplete", passes: false, decidingLayer: "integrity" });
    expect(verdict.layers.integrity.violations.map((violation) => violation.kind)).toContain("missing-attempt");
  });

  it("fails closed when a required evaluator is unavailable", () => {
    const unavailable = result({
      outcome: { kind: "incomplete", expectedMatch: false },
      scores: [{
        id: "verification-gate",
        evaluatorVersion: 1,
        status: "unavailable",
        required: true,
        evidenceIds: ["conversation"],
      }],
    });
    const verdict = calculateCohortVerdict({
      results: [unavailable],
      requiredAttempts: [{ caseId: "text.precise-box", caseVersion: 1, repetition: 1 }],
      privacy: { status: "passed", findings: [] },
    });

    expect(verdict.status).toBe("incomplete");
    expect(verdict.layers.integrity.violations.map((violation) => violation.kind)).toContain(
      "required-evaluator-unavailable",
    );
  });

  it("fails closed when a live result lacks a required semantic rubric score", () => {
    const base = result();
    const verdict = calculateCohortVerdict({
      results: [result({
        identities: {
          ...base.identities,
          rubrics: [{ id: "design-intent", version: 1, required: true, hash }],
        },
      })],
      requiredAttempts: [{ caseId: "text.precise-box", caseVersion: 1, repetition: 1 }],
      privacy: { status: "passed", findings: [] },
    });

    expect(verdict.status).toBe("incomplete");
    expect(verdict.layers.integrity.violations).toContainEqual(expect.objectContaining({
      kind: "required-score-missing",
      detail: "Required rubric design-intent has no score.",
    }));
  });

  it("fails closed when result identity is missing", () => {
    const verdict = calculateCohortVerdict({
      results: [{ schemaVersion: 1 }],
      requiredAttempts: [{ caseId: "text.precise-box", caseVersion: 1, repetition: 1 }],
      privacy: { status: "passed", findings: [] },
    });

    expect(verdict.status).toBe("incomplete");
    expect(verdict.layers.integrity.violations.map((violation) => violation.kind)).toContain(
      "missing-evaluation-identity",
    );
  });
});

describe("outcome classification", () => {
  it.each([
    ["completed", "completed", "completed"],
    ["completed", "escalated", "escalated"],
    ["completed", "blocked", "blocked"],
    ["failed", "completed", "infrastructure-failure"],
    ["interrupted", "completed", "interrupted"],
    ["incomplete", "completed", "incomplete"],
  ] as const)("classifies %s execution with %s product outcome", (execution, product, expected) => {
    expect(classifyOutcome(execution, product)).toBe(expected);
  });
});
