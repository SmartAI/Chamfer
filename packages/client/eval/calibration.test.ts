import { describe, expect, it } from "vitest";
import { buildCalibrationExperimentCohort, buildJudgeTaskInput, calibrateBinaryJudge } from "./calibration";

const identity = {
  judge: { model: "fixture-judge", prompt: "semantic-judge", promptVersion: 1, rubricVersion: 1 },
  inferenceSettings: { temperature: 0 },
  dataset: { id: "ground-truth", version: 1 },
  evaluator: { id: "binary-calibration", version: 1 },
  runId: "calibration-fixture",
};

function rows(actualFor: (index: number, expected: "ESCALATE" | "RESOLVE") => string) {
  return Array.from({ length: 20 }, (_, index) => {
    const expected = index < 10 ? "ESCALATE" as const : "RESOLVE" as const;
    return {
      evidenceId: `evidence-${index}`,
      split: "test" as const,
      evidence: { summary: `controlled evidence ${index}` },
      expected,
      actual: actualFor(index, expected),
    };
  });
}

describe("semantic judge calibration", () => {
  it("keeps expected labels out of judge task input", () => {
    expect(buildJudgeTaskInput(rows((_index, expected) => expected)[0]!)).toEqual({
      evidenceId: "evidence-0",
      evidence: { summary: "controlled evidence 0" },
    });
  });

  it("rejects split leakage", () => {
    expect(() => calibrateBinaryJudge({
      identity,
      rows: rows((_index, expected) => expected),
      promptExampleEvidenceIds: ["evidence-0"],
      positiveLabel: "ESCALATE",
      negativeLabel: "RESOLVE",
    })).toThrow(/split leakage/i);
  });

  it("fails a deliberately directionally biased judge", () => {
    const report = calibrateBinaryJudge({
      identity,
      rows: rows(() => "ESCALATE"),
      promptExampleEvidenceIds: [],
      positiveLabel: "ESCALATE",
      negativeLabel: "RESOLVE",
      policy: { minimumSensitivity: 0.9, minimumSpecificity: 0.9, minimumValidRows: 20 },
    });
    expect(report.metrics.sensitivity).toBe(1);
    expect(report.metrics.specificity).toBe(0);
    expect(report.automationAllowed).toBe(false);
  });

  it("accepts a fixture judge only when both error directions meet policy", () => {
    const report = calibrateBinaryJudge({
      identity,
      rows: rows((index, expected) => index === 0 ? "RESOLVE" : index === 10 ? "ESCALATE" : expected),
      promptExampleEvidenceIds: [],
      positiveLabel: "ESCALATE",
      negativeLabel: "RESOLVE",
      policy: { minimumSensitivity: 0.9, minimumSpecificity: 0.9, minimumValidRows: 20 },
    });
    expect(report.confusion).toEqual({ tp: 9, fp: 1, fn: 1, tn: 9 });
    expect(report.metrics.sensitivity).toBe(0.9);
    expect(report.metrics.specificity).toBe(0.9);
    expect(report.automationAllowed).toBe(true);
    const cohort = buildCalibrationExperimentCohort(report, rows((index, expected) =>
      index === 0 ? "RESOLVE" : index === 10 ? "ESCALATE" : expected
    ));
    expect(cohort.gating).toBe("automation-eligible");
    expect(cohort.cases[0]?.input).not.toHaveProperty("expected");
    expect(cohort.cases.at(-1)?.measurements.diagnostic).toContainEqual({
      name: "automation-allowed",
      value: 1,
      dataType: "BOOLEAN",
    });
  });

  it("excludes invalid labels and reports undefined denominators", () => {
    const report = calibrateBinaryJudge({
      identity,
      rows: [{
        evidenceId: "invalid",
        split: "test",
        evidence: {},
        expected: "UNKNOWN",
        actual: "RESOLVE",
      }],
      promptExampleEvidenceIds: [],
      positiveLabel: "ESCALATE",
      negativeLabel: "RESOLVE",
    });
    expect(report.validRows).toBe(0);
    expect(report.invalidRows).toBe(1);
    expect(report.metrics.accuracy).toBeNull();
    expect(report.notes.length).toBeGreaterThan(0);
    expect(report.automationAllowed).toBe(false);
  });
});
