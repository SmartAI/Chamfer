import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadEvaluationCase } from "./schema";

const corpusDir = resolve(import.meta.dirname, "cases/v1");

async function loadCorpus() {
  const names = (await readdir(corpusDir))
    .filter((name) => name.endsWith(".case.json"))
    .sort();
  return await Promise.all(names.map(async (name) => ({
    path: resolve(corpusDir, name),
    value: await loadEvaluationCase(resolve(corpusDir, name)),
  })));
}

describe("agent evaluation corpus v1", () => {
  it("contains twelve cases with unique capability coverage and intrinsic complexity", async () => {
    const corpus = await loadCorpus();

    expect(corpus).toHaveLength(12);
    expect(new Set(corpus.map(({ value }) => `${value.id}@${value.version}`)).size).toBe(12);
    expect(new Set(corpus.map(({ value }) => value.capability)).size).toBe(12);
    expect(corpus.every(({ value }) => value.complexityRationale.length >= 20)).toBe(true);
    expect(corpus.filter(({ value }) =>
      value.categories.includes("construction") && value.inputs.assets.length === 0
    )).toHaveLength(4);
    expect(corpus.filter(({ value }) => value.categories.includes("revision"))).toHaveLength(2);
    expect(corpus.filter(({ value }) => value.inputs.assets.length > 0)).toHaveLength(3);
    expect(corpus.filter(({ value }) => value.expectedOutcome.kind === "escalated")).toHaveLength(1);
    expect(corpus.filter(({ value }) => value.expectedOutcome.kind === "blocked")).toHaveLength(2);
    expect(new Set(corpus.map(({ value }) => value.complexity))).toEqual(
      new Set(["smoke", "standard", "challenge"]),
    );
  });

  it("assigns every requirement to a deterministic evaluator or semantic rubric", async () => {
    const corpus = await loadCorpus();

    for (const { value } of corpus) {
      const evaluatorIds = new Set(value.evaluatorRefs.map((reference) => reference.id));
      const rubricIds = new Set(value.rubricRefs.map((reference) => reference.id));
      for (const requirement of value.expectedOutcome.requirements) {
        if (requirement.evaluation.kind === "deterministic") {
          expect(evaluatorIds, `${value.id}/${requirement.id}`).toContain(requirement.evaluation.evaluatorId);
        } else {
          expect(rubricIds, `${value.id}/${requirement.id}`).toContain(requirement.evaluation.rubricId);
        }
      }
    }
  });

  it("retains structured safe non-completion expectations", async () => {
    const corpus = await loadCorpus();
    const escalation = corpus.find(({ value }) => value.expectedOutcome.kind === "escalated")?.value;
    const honestBlock = corpus.find(({ value }) => value.id === "safety.unverifiable-material")?.value;

    expect(escalation?.expectedOutcome).toMatchObject({
      kind: "escalated",
      escalation: {
        question: expect.any(String),
        unresolvedChoice: expect.any(String),
        retainedRequirementIds: expect.any(Array),
      },
    });
    expect(honestBlock?.expectedOutcome).toMatchObject({
      kind: "blocked",
      blocking: {
        reasonCode: "unverifiable-evidence",
        limitation: expect.any(String),
        retainedRequirementIds: expect.any(Array),
      },
    });
  });

  it("classifies cases with multiple user turns as multi-turn", async () => {
    const corpus = await loadCorpus();

    for (const { value } of corpus) {
      if (value.inputs.turns.length > 1) {
        expect(value.modality, value.id).toBe("multi-turn");
      }
    }
  });

  it("loads only declared privacy-safe image bytes with stable hashes", async () => {
    const corpus = await loadCorpus();
    const imageCases = corpus.filter(({ value }) => value.inputs.assets.length > 0);

    for (const { path, value } of imageCases) {
      for (const asset of value.inputs.assets) {
        const bytes = await readFile(resolve(dirname(path), asset.path));
        expect(createHash("sha256").update(bytes).digest("hex"), `${value.id}/${asset.id}`).toBe(asset.sha256);
        expect(["synthetic", "generated", "consent-safe", "redistributable"]).toContain(asset.provenance);
        expect(asset.expectedRole.length).toBeGreaterThan(0);
      }
    }
  });
});
