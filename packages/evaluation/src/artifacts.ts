import { resolve, sep } from "node:path";

export function evaluationArtifactRoot(repoRoot: string): string {
  return resolve(repoRoot, "docs/internal/evaluations");
}

export function safeEvaluationArtifactPath(repoRoot: string, requestedPath: string): string {
  const root = evaluationArtifactRoot(repoRoot);
  const candidate = resolve(repoRoot, requestedPath);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    throw new Error("Evaluation artifacts must stay under docs/internal/evaluations");
  }
  return candidate;
}
