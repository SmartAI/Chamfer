import { describe, expect, it } from "vitest";
import { scoreOnlineRuns, safeScoreOnlineRuns, type OnlineRunEvidence } from "./onlineScoring";

function run(overrides: Partial<OnlineRunEvidence> = {}): OnlineRunEvidence {
  return {
    runId: "run-1",
    release: "0.2.2",
    agentConfigurationHash: "sha256:agent",
    provider: "fixture",
    model: "fixture-model",
    modality: "text",
    lifecycleComplete: true,
    planStatus: "completed",
    verificationGate: "passed",
    requiredEvidence: 2,
    observedEvidence: 2,
    completionClaimed: true,
    toolErrors: 0,
    cadFailures: 0,
    retries: 0,
    cost: 0.01,
    latencyMs: 100,
    persistenceFailures: 0,
    ...overrides,
  };
}

const policy = {
  version: 1,
  randomSampleRate: 0,
  maximumReviewItems: 10,
  unusualCost: 1,
  unusualLatencyMs: 10_000,
  toolErrorCluster: 3,
  repeatedCadFailures: 2,
};

describe("online deterministic scoring and sampling", () => {
  it("does not call a production task successful from a verification pass", () => {
    const result = scoreOnlineRuns({
      runs: [run()],
      policy,
      knownReleases: ["0.2.2"],
      knownFailureSignatures: [],
      previouslySelectedRunIds: [],
    });
    expect(result.scores[0]?.taskSuccess).toBe("unavailable");
    expect(result.scores[0]?.provenance).toEqual({ scorer: "online-deterministic", version: 1 });
    expect(result.reviewInventory).toEqual([]);
  });

  it("records random and risk-triggered reasons without duplicating review items", () => {
    const result = scoreOnlineRuns({
      runs: [
        run({ runId: "random" }),
        run({ runId: "risk", explicitFeedback: "negative", cadFailures: 2 }),
        run({ runId: "already-selected", toolErrors: 4 }),
      ],
      policy: { ...policy, randomSampleRate: 1, maximumReviewItems: 2 },
      knownReleases: ["0.2.2"],
      knownFailureSignatures: [],
      previouslySelectedRunIds: ["already-selected"],
    });
    expect(result.reviewInventory).toHaveLength(2);
    expect(result.reviewInventory.find((item) => item.runId === "risk")?.reasons).toEqual([
      "explicit-negative-feedback",
      "repeated-cad-failures",
    ]);
    expect(result.reviewInventory.some((item) => item.runId === "already-selected")).toBe(false);
  });

  it("segments scores and flags new releases, false success, and new failure signatures", () => {
    const result = scoreOnlineRuns({
      runs: [run({
        release: "0.3.0",
        verificationGate: "failed",
        failureSignature: "new-signature",
      })],
      policy,
      knownReleases: ["0.2.2"],
      knownFailureSignatures: [],
      previouslySelectedRunIds: [],
    });
    expect(result.scores[0]?.segment).toMatchObject({ release: "0.3.0", modality: "text" });
    expect(result.reviewInventory[0]?.reasons).toEqual([
      "new-release",
      "suspected-false-success",
      "new-failure-signature",
    ]);
  });

  it("isolates scorer outages as unavailable monitoring evidence", () => {
    const result = safeScoreOnlineRuns(() => {
      throw new Error("monitoring store unavailable");
    });
    expect(result).toEqual({ status: "unavailable", reason: "monitoring store unavailable" });
  });
});
