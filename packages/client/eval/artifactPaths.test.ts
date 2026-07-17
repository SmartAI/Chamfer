import { describe, expect, it } from "vitest";
import { validatePrivateArtifactOutput } from "./artifactPaths";

describe("private evaluation artifact paths", () => {
  it("allows operating-system temporary paths and ignored internal paths", () => {
    expect(() => validatePrivateArtifactOutput("/workspace/chamfer", "/tmp/chamfer-eval")).not.toThrow();
    expect(() => validatePrivateArtifactOutput(
      "/workspace/chamfer",
      "/workspace/chamfer/docs/internal/evaluations/run-1",
    )).not.toThrow();
  });

  it("rejects report output elsewhere inside the public repository", () => {
    expect(() => validatePrivateArtifactOutput(
      "/workspace/chamfer",
      "/workspace/chamfer/evaluation-output",
    )).toThrow(/docs\/internal/i);
  });
});
