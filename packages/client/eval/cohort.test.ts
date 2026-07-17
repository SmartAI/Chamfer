import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EvaluationIdentities } from "./identity";
import { buildAttemptSchedule, buildPairedAttemptSchedule, loadResumableResult } from "./cohort";
import { parseEvaluationResult } from "./result";

const directories: string[] = [];
const hash = `sha256:${"c".repeat(64)}`;
const identities: EvaluationIdentities = {
  corpus: { id: "tracer", version: 1, hash },
  case: {
    id: "text.precise-box",
    version: 1,
    hash,
    purpose: "Fixture",
    modality: "text",
    complexity: "smoke",
    categories: ["construction"],
    gatingStatus: "release",
  },
  assets: [],
  agentConfiguration: {
    hash,
    productRelease: "0.2.1",
    gitCommit: "fixture-commit",
    dirty: false,
    promptHash: hash,
    skillHash: hash,
    policyHash: hash,
    toolsetHash: hash,
    provider: "anthropic",
    model: "fixture-model",
    inferenceSettingsHash: hash,
  },
  evaluators: [{ id: "verification-gate", version: 1, required: true, hash }],
  rubrics: [],
  runner: { version: 1, hash },
  environment: {
    hash,
    node: "26.4.0",
    browser: "chromium",
    operatingSystem: "darwin",
    architecture: "arm64",
    productBuildHash: hash,
  },
  repetition: { index: 1, hash },
};

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function completedResult() {
  return parseEvaluationResult({
    schemaVersion: 1,
    identities,
    evidenceClass: "proficiency",
    execution: {
      state: "completed",
      startedAt: "2026-07-13T07:00:00.000Z",
      finishedAt: "2026-07-13T07:00:01.000Z",
      durationMs: 1_000,
    },
    outcome: { kind: "completed", expectedMatch: true },
    evidence: [{ id: "conversation", kind: "conversation", reference: "conversation:fixture" }],
    measurements: {
      cadRuns: 1,
      modelCalls: 2,
      toolCalls: 1,
      toolErrors: 0,
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      providerCost: 0.01,
    },
    scores: [{
      id: "verification-gate",
      evaluatorVersion: 1,
      status: "passed",
      required: true,
      value: 1,
      evidenceIds: ["conversation"],
    }],
    proficiency: { included: true },
    integrity: { violations: [] },
  });
}

describe("cohort attempts", () => {
  it("creates every case repetition exactly once", () => {
    const schedule = buildAttemptSchedule([
      { id: "case-a", version: 1 },
      { id: "case-b", version: 2 },
    ], 3, 17);

    expect(schedule).toHaveLength(6);
    expect(new Set(schedule.map((attempt) => `${attempt.caseId}@${attempt.caseVersion}#${attempt.repetition}`)).size)
      .toBe(6);
  });

  it("interleaves candidate and control attempts in one seeded window", () => {
    const schedule = buildPairedAttemptSchedule([{ id: "case-a", version: 1 }], 3, 17);

    expect(schedule).toHaveLength(6);
    expect(schedule.filter((attempt) => attempt.cohort === "candidate")).toHaveLength(3);
    expect(schedule.filter((attempt) => attempt.cohort === "control")).toHaveLength(3);
    expect(schedule.map((attempt) => attempt.cohort)).not.toEqual([
      "candidate",
      "candidate",
      "candidate",
      "control",
      "control",
      "control",
    ]);
  });

  it("resumes a completed attempt only when its identity is unchanged", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chamfer-resume-test-"));
    directories.push(directory);
    const path = join(directory, "result.json");
    await writeFile(path, JSON.stringify(completedResult()));

    await expect(loadResumableResult(path, identities)).resolves.toMatchObject({
      execution: { state: "completed" },
    });
    await expect(loadResumableResult(path, {
      ...identities,
      agentConfiguration: {
        ...identities.agentConfiguration,
        hash: `sha256:${"d".repeat(64)}`,
      },
    })).rejects.toThrow(/identity conflict/i);
  });
});
