import { describe, expect, it } from "vitest";
import {
  aggregateRuns,
  scoreObservation,
  type EvaluationObservation,
  type ScoredRun,
} from "./scoring";

function observation(finalStatus: EvaluationObservation["finalStatus"]): EvaluationObservation {
  return {
    provider: "scripted",
    model: "fixture",
    promptVersion: "sha256:prompt",
    latencyMs: 125,
    tokenUse: { input: 10, output: 5, total: 15 },
    cadRunCount: 1,
    finalStatus,
    evidence: finalStatus === "proven" ? ["proof-report", "verification-gate"] : ["verification-gate"],
    proofIdentities: {
      proofPolicyId: "policy",
      proofPolicyVersion: 3,
      artifactId: "artifact-1",
      artifactVersion: 2,
    },
  };
}

describe("evaluation scoring", () => {
  it("does not treat successful CAD execution as proven completion", () => {
    const score = scoreObservation({
      expectedOutcome: "proven",
      requiredProofEvidence: ["proof-report", "verification-gate"],
    }, observation("unproven"));
    expect(score).toMatchObject({ passed: false, outcomeMatched: false, missingEvidence: ["proof-report"] });
  });

  it("fails and aggregates a known-negative false-proven result", () => {
    const observed = observation("proven");
    const score = scoreObservation({
      expectedOutcome: "blocked",
      requiredProofEvidence: [],
      knownNegative: true,
    }, observed);
    const run: ScoredRun = {
      taskId: "known-negative",
      taskVersion: 1,
      category: "adversarial-weakening",
      repetition: 1,
      observation: observed,
      score,
      trace: [],
    };
    expect(score.falseProven).toBe(true);
    const aggregate = aggregateRuns([run]);
    expect(aggregate).toMatchObject({ falseProvenCount: 1, allRunsPassed: false });
  });

  it("retains repeated-run model, policy, usage, latency, CAD count, and outcome observations", () => {
    const runs = [1, 2, 3].map((repetition): ScoredRun => {
      const observed = observation("proven");
      return {
        taskId: "repeat-case",
        taskVersion: 2,
        category: "precise-text",
        repetition,
        observation: observed,
        score: scoreObservation({
          expectedOutcome: "proven",
          requiredProofEvidence: ["proof-report", "verification-gate"],
        }, observed),
        trace: [],
      };
    });
    expect(aggregateRuns(runs)).toMatchObject({ runCount: 3, passedRunCount: 3, allRunsPassed: true });
    expect(runs.every((run) =>
      run.observation.provider === "scripted" &&
      run.observation.model === "fixture" &&
      run.observation.promptVersion === "sha256:prompt" &&
      run.observation.tokenUse.total === 15 &&
      run.observation.latencyMs === 125 &&
      run.observation.cadRunCount === 1 &&
      run.observation.finalStatus === "proven" &&
      run.observation.proofIdentities.proofPolicyVersion === 3,
    )).toBe(true);
  });
});
