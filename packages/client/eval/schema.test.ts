import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadEvaluationCase, parseEvaluationCase } from "./schema";

const preciseBoxPath = resolve(import.meta.dirname, "cases/v1/precise-box.case.json");

describe("evaluation case loading", () => {
  it("loads the versioned precise text case through the public contract", async () => {
    const evaluationCase = await loadEvaluationCase(preciseBoxPath);

    expect(evaluationCase).toMatchObject({
      schemaVersion: 1,
      id: "text.precise-box",
      version: 1,
      capability: "precise-prismatic-envelope",
      modality: "text",
      complexity: "smoke",
      capabilityStatus: "supported",
      gatingStatus: "release",
      expectedOutcome: { kind: "completed" },
      sourceSafety: { classification: "synthetic", containsProductionData: false },
    });
    expect(evaluationCase.requiredEvidence.map((evidence) => evidence.id)).toEqual([
      "verification-gate",
      "bbox",
      "single-body",
    ]);
    expect(evaluationCase.evaluatorRefs.find((reference) => reference.id === "bbox")?.config).toEqual({
      expectedMm: [10, 20, 30],
      toleranceMm: 0.5,
    });
  });

  it("rejects malformed cases before execution", () => {
    expect(() => parseEvaluationCase({ schemaVersion: 1, id: "missing-fields" })).toThrow(
      /evaluation case/i,
    );
  });
});
