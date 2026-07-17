import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";

const execFileAsync = promisify(execFile);

test("scripted evaluation runs through a fresh production browser stack", async () => {
  test.setTimeout(600_000);
  const outputDir = await mkdtemp(join(tmpdir(), "chamfer-evaluation-e2e-"));
  try {
    await execFileAsync("npm", [
      "run",
      "eval:agent",
      "--",
      `--output=${outputDir}`,
      "--client-port=5473",
      "--api-port=9087",
    ], {
      cwd: process.cwd(),
      timeout: 580_000,
    });

    const jsonPath = join(outputDir, "text.precise-box-v1-r1.json");
    const markdownPath = join(outputDir, "text.precise-box-v1-r1.md");
    const result = JSON.parse(await readFile(jsonPath, "utf8")) as {
      evidenceClass: string;
      execution: { state: string };
      outcome: { kind: string; expectedMatch: boolean };
      proficiency: { included: boolean };
      measurements: { gatePassed?: boolean; boundingBoxMm?: number[] };
    };
    const markdown = await readFile(markdownPath, "utf8");

    expect(result).toMatchObject({
      evidenceClass: "infrastructure",
      execution: { state: "completed" },
      outcome: { kind: "completed", expectedMatch: true },
      proficiency: { included: false },
      measurements: { gatePassed: true, boundingBoxMm: [10, 20, 30] },
    });
    expect(markdown).toContain("# Evaluation: text.precise-box v1");
    expect(markdown).toContain("| Expected outcome matched | yes |");
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("known-negative completion fails the integrity verdict", async () => {
  test.setTimeout(600_000);
  const outputDir = await mkdtemp(join(tmpdir(), "chamfer-false-success-e2e-"));
  const canonicalCasePath = join(
    process.cwd(),
    "packages/client/eval/cases/v1/false-success.case.json",
  );
  const injectedCasePath = join(outputDir, "injected-false-success.case.json");
  try {
    const injectedCase = JSON.parse(await readFile(canonicalCasePath, "utf8")) as {
      inputs: { turns: Array<{ text: string }> };
    };
    injectedCase.inputs.turns[0]!.text += " fixture-unsafe";
    await writeFile(injectedCasePath, `${JSON.stringify(injectedCase, null, 2)}\n`);
    await expect(execFileAsync("npm", [
      "run",
      "eval:agent",
      "--",
      `--cases=${injectedCasePath}`,
      `--output=${outputDir}`,
      "--client-port=5573",
      "--api-port=9187",
    ], {
      cwd: process.cwd(),
      timeout: 580_000,
    })).rejects.toThrow();

    const result = JSON.parse(
      await readFile(join(outputDir, "safety.false-success-v1-r1.json"), "utf8"),
    ) as { integrity: { violations: string[] } };
    const verdict = JSON.parse(
      await readFile(join(outputDir, "cohort-verdict.json"), "utf8"),
    ) as {
      status: string;
      decidingLayer: string;
      layers: { integrity: { violations: Array<{ kind: string }> } };
    };

    expect(result.integrity.violations).toContain("known-negative-success");
    expect(verdict).toMatchObject({ status: "failed", decidingLayer: "integrity" });
    expect(verdict.layers.integrity.violations.map((violation) => violation.kind)).toContain(
      "known-negative-success",
    );
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});
