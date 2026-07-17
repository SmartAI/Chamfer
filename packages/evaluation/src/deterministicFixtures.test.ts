import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runDeterministicFixtures } from "./deterministicFixtures";

describe("deterministic evaluator fixtures", () => {
  it("produces every pinned expected verdict", () => {
    const report = runDeterministicFixtures(JSON.parse(readFileSync(
      resolve(process.cwd(), "corpus/deterministic-v1.json"),
      "utf8",
    )));
    expect(report).toMatchObject({ fixtureCount: 5, matchedCount: 5, allMatched: true });
    expect(report.results.find((result) => result.id === "known-negative-proven-rejected"))
      .toMatchObject({ passed: false, falseProven: true, matched: true });
  });

  it("fails when a fixture expectation drifts", () => {
    const report = runDeterministicFixtures({
      schemaVersion: 1,
      fixtureVersion: 1,
      fixtures: [{
        id: "drifted-fixture",
        expectation: { expectedOutcome: "blocked", requiredProofEvidence: ["blocked-reason"] },
        observation: {
          provider: "fixture",
          model: "deterministic",
          promptVersion: "sha256:fixture",
          latencyMs: 0,
          tokenUse: { input: 0, output: 0, total: 0 },
          cadRunCount: 0,
          finalStatus: "blocked",
          evidence: ["blocked-reason"],
          proofIdentities: { proofPolicyId: "fixture-policy", proofPolicyVersion: 1 },
        },
        expected: { passed: false, falseProven: false },
      }],
    });
    expect(report).toMatchObject({ fixtureCount: 1, matchedCount: 0, allMatched: false });
  });
});
