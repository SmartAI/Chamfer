import { describe, expect, it } from "vitest";
import { buildPairedRunPlan } from "./paired";

describe("paired evaluation plan", () => {
  it("interleaves both products and preserves matching case repetitions", () => {
    const plan = buildPairedRunPlan({
      cases: [{ id: "case-a", version: 1 }, { id: "case-b", version: 1 }],
      repetitions: 2,
      seed: 17,
      candidateRoot: "/candidate",
      controlRoot: "/control",
    });

    expect(plan).toHaveLength(8);
    for (const caseId of ["case-a", "case-b"]) {
      for (const repetition of [1, 2]) {
        expect(plan.filter((entry) => entry.attempt.caseId === caseId &&
          entry.attempt.repetition === repetition).map((entry) => entry.cohort).sort()).toEqual([
          "candidate",
          "control",
        ]);
      }
    }
    expect(new Set(plan.map((entry) => entry.productRoot))).toEqual(new Set(["/candidate", "/control"]));
  });
});
