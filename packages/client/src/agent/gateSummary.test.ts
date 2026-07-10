import { describe, expect, it } from "vitest";
import { latestGateSummary } from "./gateSummary";

function runResult(status: string, checks: Array<{ passed: boolean }>): unknown {
  return {
    role: "toolResult",
    toolCallId: "tc",
    content: [],
    details: { gate: { status, checks: checks.map((c, i) => ({ name: `c${i}`, passed: c.passed, detail: "d" })) } },
  };
}

describe("latestGateSummary", () => {
  it("returns undefined with no gate-bearing messages", () => {
    expect(latestGateSummary([])).toBeUndefined();
    expect(latestGateSummary([{ role: "user", content: "hi" }, { role: "toolResult", details: {} }])).toBeUndefined();
  });

  it("summarizes the latest gate with check counts", () => {
    const messages = [
      { role: "user", content: "make it" },
      runResult("failed", [{ passed: true }, { passed: false }]),
      { role: "assistant", content: "fixing" },
      runResult("passed", [{ passed: true }, { passed: true }, { passed: true }]),
      { role: "assistant", content: "done" },
    ];
    expect(latestGateSummary(messages)).toEqual({ status: "passed", passedChecks: 3, totalChecks: 3 });
  });

  it("picks the last gate even when it failed", () => {
    const messages = [runResult("passed", [{ passed: true }]), runResult("failed", [{ passed: false }])];
    expect(latestGateSummary(messages)).toEqual({ status: "failed", passedChecks: 0, totalChecks: 1 });
  });

  it("reports error gates and tolerates malformed shapes", () => {
    expect(latestGateSummary([runResult("error", [])])).toEqual({ status: "error", passedChecks: 0, totalChecks: 0 });
    expect(latestGateSummary([runResult("nonsense", [])])).toBeUndefined();
    expect(latestGateSummary([{ role: "toolResult", details: { gate: "oops" } }])).toBeUndefined();
    expect(latestGateSummary([null, 42, "x"])).toBeUndefined();
  });
});
