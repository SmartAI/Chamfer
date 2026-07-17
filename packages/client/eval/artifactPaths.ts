import { isAbsolute, relative, resolve } from "node:path";

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

export function validatePrivateArtifactOutput(repoRoot: string, outputDir: string): void {
  const resolvedRoot = resolve(repoRoot);
  const resolvedOutput = resolve(outputDir);
  const privateRoot = resolve(resolvedRoot, "docs/internal");
  if (isWithin(resolvedRoot, resolvedOutput) && !isWithin(privateRoot, resolvedOutput)) {
    throw new Error("Evaluation artifacts inside the repository must be written under ignored docs/internal");
  }
}
