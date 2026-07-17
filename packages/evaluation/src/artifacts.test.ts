import { describe, expect, it } from "vitest";
import { safeEvaluationArtifactPath } from "./artifacts";

describe("evaluation artifact boundary", () => {
  it("allows only private git-ignored evaluation output", () => {
    const root = "/workspace/chamfer";
    expect(safeEvaluationArtifactPath(root, "docs/internal/evaluations/run-1"))
      .toBe("/workspace/chamfer/docs/internal/evaluations/run-1");
    expect(() => safeEvaluationArtifactPath(root, "packages/evaluation/results.json"))
      .toThrow("docs/internal/evaluations");
    expect(() => safeEvaluationArtifactPath(root, "docs/internal/evaluations/../../../public.json"))
      .toThrow("docs/internal/evaluations");
  });
});
