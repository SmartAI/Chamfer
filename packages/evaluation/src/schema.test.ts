import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseEvaluationCorpus, parseReleaseEvaluationCorpus } from "./schema";

describe("evaluation corpus schema", () => {
  it("loads a versioned initial case in every tracer category", () => {
    const corpus = parseEvaluationCorpus(JSON.parse(readFileSync(
      resolve(process.cwd(), "corpus/tracer-v1.json"),
      "utf8",
    )));
    expect(new Set(corpus.tasks.map((task) => task.category))).toEqual(new Set([
      "precise-text",
      "dimensioned-reference",
      "adversarial-weakening",
      "conflicting-evidence",
      "impossible-or-blocked",
    ]));
    expect(corpus.tasks.every((task) =>
      task.taskVersion > 0 && task.modelConfiguration.repetitions > 0 && task.proofPolicy.version > 0,
    )).toBe(true);
  });

  it("rejects duplicate task identities", () => {
    const task = {
      schemaVersion: 1,
      id: "duplicate-case",
      taskVersion: 1,
      category: "precise-text",
      prompt: "synthetic task",
      expectedOutcome: "proven",
      requiredProofEvidence: ["proof-report"],
      modelConfiguration: { provider: "test", model: "test", repetitions: 1 },
      proofPolicy: { id: "policy", version: 1 },
    };
    expect(() => parseEvaluationCorpus({
      schemaVersion: 1,
      corpusId: "duplicate-corpus",
      corpusVersion: 1,
      tasks: [task, task],
    })).toThrow("duplicate task id");
  });

  it("loads the release corpus with its complete pinned inventory", () => {
    const corpus = parseReleaseEvaluationCorpus(JSON.parse(readFileSync(
      resolve(process.cwd(), "corpus/proven-single-part-v1.json"),
      "utf8",
    )));
    const counts = corpus.tasks.reduce<Record<string, number>>((result, task) => {
      result[task.category] = (result[task.category] ?? 0) + 1;
      return result;
    }, {});
    expect(corpus.tasks).toHaveLength(50);
    expect(counts).toEqual(corpus.releasePolicy.requiredCategoryCounts);
    expect(corpus.tasks.every((task) => task.sourceSafety && task.modelConfiguration.repetitions === 3)).toBe(true);
  });
});
