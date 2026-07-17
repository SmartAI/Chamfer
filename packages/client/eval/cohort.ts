import { readFile } from "node:fs/promises";
import { canonicalJson, type EvaluationIdentities } from "./identity";
import { parseEvaluationResult, type EvaluationResult } from "./result";

export interface AttemptScheduleEntry {
  caseId: string;
  caseVersion: number;
  repetition: number;
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (1_664_525 * state + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

export function buildAttemptSchedule(
  cases: Array<{ id: string; version: number }>,
  repetitions: number,
  seed: number,
): AttemptScheduleEntry[] {
  if (!Number.isInteger(repetitions) || repetitions < 1) throw new Error("Repetitions must be a positive integer");
  if (!Number.isInteger(seed) || seed < 0) throw new Error("Schedule seed must be a non-negative integer");
  const attempts = cases.flatMap((evaluationCase) =>
    Array.from({ length: repetitions }, (_, index) => ({
      caseId: evaluationCase.id,
      caseVersion: evaluationCase.version,
      repetition: index + 1,
    }))
  );
  const random = seededRandom(seed);
  for (let index = attempts.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [attempts[index], attempts[swap]] = [attempts[swap]!, attempts[index]!];
  }
  return attempts;
}

export function buildPairedAttemptSchedule(
  cases: Array<{ id: string; version: number }>,
  repetitions: number,
  seed: number,
): Array<AttemptScheduleEntry & { cohort: "candidate" | "control" }> {
  const attempts = buildAttemptSchedule(cases, repetitions, seed).flatMap((attempt) => [
    { ...attempt, cohort: "candidate" as const },
    { ...attempt, cohort: "control" as const },
  ]);
  const random = seededRandom(seed ^ 0x9e3779b9);
  for (let index = attempts.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [attempts[index], attempts[swap]] = [attempts[swap]!, attempts[index]!];
  }
  return attempts;
}

export async function loadResumableResult(
  path: string,
  expectedIdentities: EvaluationIdentities,
): Promise<EvaluationResult | undefined> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const result = parseEvaluationResult(JSON.parse(content));
  if (canonicalJson(result.identities) !== canonicalJson(expectedIdentities)) {
    throw new Error(`Resume identity conflict for ${path}`);
  }
  return result.execution.state === "completed" ? result : undefined;
}
