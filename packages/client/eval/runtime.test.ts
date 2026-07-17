import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertExpectedProductCommit,
  assertSupportedNodeVersion,
  loadEvaluationDotenv,
  resolveCliPath,
  resolveEvaluationRoots,
} from "./runtime";

describe("evaluation runtime roots", () => {
  it("uses the implementation root for evaluator code and a separate product root when supplied", () => {
    expect(resolveEvaluationRoots({
      repoRoot: "/workspace/candidate",
      productRoot: "/workspace/v0.2.1",
    })).toEqual({
      implementationRoot: "/workspace/candidate",
      productRoot: "/workspace/v0.2.1",
    });
  });

  it("defaults the product under test to the implementation root", () => {
    expect(resolveEvaluationRoots({ repoRoot: "/workspace/candidate" })).toEqual({
      implementationRoot: "/workspace/candidate",
      productRoot: "/workspace/candidate",
    });
  });

  it("fails closed when an anchored product commit does not match", () => {
    expect(() => assertExpectedProductCommit("a".repeat(40), "b".repeat(40))).toThrow(
      /product commit mismatch/i,
    );
  });

  it("enforces the complete minimum Node version instead of checking only the major", () => {
    expect(() => assertSupportedNodeVersion("22.18.0")).toThrow(/22\.19 or newer/i);
    expect(() => assertSupportedNodeVersion("22.19.0")).not.toThrow();
    expect(() => assertSupportedNodeVersion("26.4.0")).not.toThrow();
  });

  it("resolves repository-relative CLI paths independently of the workspace cwd", () => {
    expect(resolveCliPath({
      value: "packages/client/eval/cases/v1/example.case.json",
      cwd: "/workspace/chamfer/packages/client",
      repoRoot: "/workspace/chamfer",
      cwdPathExists: false,
    })).toBe("/workspace/chamfer/packages/client/eval/cases/v1/example.case.json");
  });

  it("loads the nearest dotenv for external product roots without overriding shell variables", async () => {
    const root = await mkdtemp(join(tmpdir(), "chamfer-evaluation-env-"));
    const nested = join(root, "packages", "client");
    await mkdir(nested, { recursive: true });
    await writeFile(join(root, ".env"), "GEMINI_API_KEY=base-key\nCHAMFER_MODEL=base-model\n");
    await writeFile(join(root, ".env.local"), "GEMINI_API_KEY=local-key\nCHAMFER_MODEL=local-model\n");
    const env = { CHAMFER_MODEL: "shell-model" };

    expect(loadEvaluationDotenv(nested, env)).toEqual([
      join(root, ".env"),
      join(root, ".env.local"),
    ]);
    expect(env).toEqual({ CHAMFER_MODEL: "shell-model", GEMINI_API_KEY: "local-key" });
  });
});
