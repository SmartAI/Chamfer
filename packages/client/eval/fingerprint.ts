import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function filesBelow(path: string): Promise<string[]> {
  const entries = await readdir(path, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => resolve(entry.parentPath, entry.name));
}

export async function hashFiles(root: string, paths: string[]): Promise<string> {
  const expanded: string[] = [];
  for (const path of paths) {
    const absolute = resolve(root, path);
    expanded.push(...((await stat(absolute)).isDirectory() ? await filesBelow(absolute) : [absolute]));
  }
  expanded.sort((left, right) => relative(root, left).localeCompare(relative(root, right)));
  const hash = createHash("sha256");
  for (const file of expanded) {
    const name = relative(root, file);
    const content = await readFile(file);
    hash.update(`${name.length}:${name}:${content.length}:`);
    hash.update(content);
  }
  return `sha256:${hash.digest("hex")}`;
}

export async function gitIdentity(repoRoot: string): Promise<{ commit: string; dirty: boolean }> {
  const [{ stdout: commit }, { stdout: status }] = await Promise.all([
    execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoRoot }),
    execFileAsync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: repoRoot }),
  ]);
  const resolvedCommit = commit.trim();
  if (!/^[a-f0-9]{40}$/.test(resolvedCommit)) throw new Error("Could not resolve the evaluation git commit");
  return { commit: resolvedCommit, dirty: status.trim().length > 0 };
}
