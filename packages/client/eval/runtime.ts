import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parseEnv } from "node:util";

export interface EvaluationRoots {
  implementationRoot: string;
  productRoot: string;
}

export function loadEvaluationDotenv(
  startDir: string,
  env: Record<string, string | undefined> = process.env,
): string[] {
  let directory = resolve(startDir);
  for (;;) {
    if (existsSync(join(directory, ".env")) || existsSync(join(directory, ".env.local"))) break;
    const parent = dirname(directory);
    if (parent === directory) return [];
    directory = parent;
  }
  const loaded: string[] = [];
  const fromFiles: Record<string, string> = {};
  for (const name of [".env", ".env.local"] as const) {
    const path = join(directory, name);
    if (!existsSync(path)) continue;
    Object.assign(fromFiles, parseEnv(readFileSync(path, "utf8")));
    loaded.push(path);
  }
  for (const [key, value] of Object.entries(fromFiles)) {
    if (!(key in env)) env[key] = value;
  }
  return loaded;
}

export function resolveEvaluationRoots(input: { repoRoot: string; productRoot?: string }): EvaluationRoots {
  const implementationRoot = resolve(input.repoRoot);
  return {
    implementationRoot,
    productRoot: resolve(input.productRoot ?? implementationRoot),
  };
}

export function assertExpectedProductCommit(actual: string, expected?: string): void {
  if (expected !== undefined && actual !== expected) {
    throw new Error(`Product commit mismatch: expected ${expected}, resolved ${actual}`);
  }
}

export function assertSupportedNodeVersion(version: string): void {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) throw new Error(`Could not parse Node version ${version}`);
  const [, majorText, minorText] = match;
  const major = Number(majorText);
  const minor = Number(minorText);
  if (major < 22 || (major === 22 && minor < 19)) {
    throw new Error(`Agent evaluation requires Node 22.19 or newer, found ${version}`);
  }
}

export function resolveCliPath(input: {
  value: string;
  cwd: string;
  repoRoot: string;
  cwdPathExists: boolean;
}): string {
  if (isAbsolute(input.value)) return resolve(input.value);
  return resolve(input.cwdPathExists ? input.cwd : input.repoRoot, input.value);
}
