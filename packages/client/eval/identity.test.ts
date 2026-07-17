import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJson, createEvaluationIdentities, sha256Identity } from "./identity";
import { loadEvaluationCase } from "./schema";

const preciseBoxPath = resolve(import.meta.dirname, "cases/v1/precise-box.case.json");

describe("evaluation identity", () => {
  it("hashes normalized input with a stable canonical representation", () => {
    expect(canonicalJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    expect(sha256Identity({ b: 2, a: 1 })).toBe(
      "sha256:43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777",
    );
  });

  it("resolves every required identity before execution", async () => {
    const evaluationCase = await loadEvaluationCase(preciseBoxPath);
    const identities = createEvaluationIdentities({
      corpus: { id: "tracer", version: 1, cases: [evaluationCase] },
      evaluationCase,
      agentConfiguration: {
        productRelease: "0.2.1",
        gitCommit: "c34c7ed1c34c7ed1c34c7ed1c34c7ed1c34c7ed1",
        dirty: false,
        promptHash: "sha256:prompt",
        skillHash: "sha256:skill",
        policyHash: "sha256:policy",
        toolsetHash: "sha256:toolset",
        provider: "anthropic",
        model: "chamfer-fake",
        inferenceSettings: {},
      },
      evaluatorDefinitions: evaluationCase.evaluatorRefs.map((reference) => ({
        ...reference,
        sourceHash: `sha256:${reference.id}`,
      })),
      rubricDefinitions: [],
      runner: { version: 1, sourceHash: "sha256:runner" },
      environment: {
        node: "26.4.0",
        browser: "chromium",
        operatingSystem: "darwin",
        architecture: "arm64",
        productBuildHash: "sha256:build",
      },
      repetition: { index: 1, seed: 7, depth: "scripted" },
    });

    expect(Object.keys(identities)).toEqual([
      "corpus",
      "case",
      "assets",
      "agentConfiguration",
      "evaluators",
      "rubrics",
      "runner",
      "environment",
      "repetition",
    ]);
    expect(Object.values(identities).flatMap((identity) =>
      Array.isArray(identity) ? identity.map((item) => item.hash) : [identity.hash]
    ).every((hash) => /^sha256:[a-f0-9]{64}$/.test(hash))).toBe(true);
  });

  it("rejects unresolved required identity input", async () => {
    const evaluationCase = await loadEvaluationCase(preciseBoxPath);
    expect(() => createEvaluationIdentities({
      corpus: { id: "tracer", version: 1, cases: [evaluationCase] },
      evaluationCase,
      agentConfiguration: {
        productRelease: "0.2.1",
        gitCommit: "",
        dirty: false,
        promptHash: "sha256:prompt",
        skillHash: "sha256:skill",
        policyHash: "sha256:policy",
        toolsetHash: "sha256:toolset",
        provider: "anthropic",
        model: "chamfer-fake",
        inferenceSettings: {},
      },
      evaluatorDefinitions: [],
      rubricDefinitions: [],
      runner: { version: 1, sourceHash: "sha256:runner" },
      environment: {
        node: "26.4.0",
        browser: "chromium",
        operatingSystem: "darwin",
        architecture: "arm64",
        productBuildHash: "sha256:build",
      },
      repetition: { index: 1, seed: 7, depth: "scripted" },
    })).toThrow(/gitCommit/);
  });
});
