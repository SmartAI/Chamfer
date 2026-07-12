import { formatSkillInvocation, formatSkillsForSystemPrompt, type Skill } from "@earendil-works/pi-agent-core";

/**
 * Registry of Chamfer's build123d modeling skills, the tier-2 layer of the
 * progressive-disclosure design: the system prompt carries only the catalog
 * (name + description per skill); the model pulls a full skill body - and any
 * resource file it references - through the load_skill tool.
 *
 * Skills are authored as `skills/<name>/SKILL.md` in the pi-agent-core /
 * agentskills.io convention (YAML frontmatter with `name` matching the folder
 * and a required `description`) and bundled into the client as raw strings;
 * the browser runtime has no filesystem, so pi's ExecutionEnv-based loadSkills
 * cannot run here and this module reimplements only its parsing contract.
 * pi's Skill type and prompt formatting are reused verbatim.
 *
 * A body may embed a Python file with a `{{snippet:snippets/<file>.py}}` line;
 * the exact same bytes are executed against real build123d by
 * py-tests/test_skill_snippets.py, so every inline example is pinned honest.
 */

const skillFiles = import.meta.glob("./skills/*/SKILL.md", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const resourceFiles = import.meta.glob("./skills/*/snippets/*.py", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

export interface ChamferSkill extends Skill {
  /** Resource files under the skill folder, keyed by skill-relative path (e.g. "snippets/helix.py"). */
  resources: ReadonlyMap<string, string>;
}

/** Matches pi-agent-core's SKILL.md name rules (loadSkillFromFile validation). */
const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const SNIPPET_MARKER = /\{\{snippet:([^}]+)\}\}/g;

/** Prose word budget per skill body (code blocks excluded); the authoring target is 350-600. */
export const MAX_SKILL_PROSE_WORDS = 800;

interface ParsedFrontmatter {
  frontmatter: Record<string, string>;
  body: string;
}

/**
 * Minimal frontmatter parser matching pi's parseFrontmatter semantics for the
 * subset Chamfer authors: single-line `key: value` scalars between `---` fences.
 */
function parseFrontmatter(content: string): ParsedFrontmatter {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized.startsWith("---")) return { frontmatter: {}, body: normalized };
  const endIndex = normalized.indexOf("\n---", 3);
  if (endIndex === -1) return { frontmatter: {}, body: normalized };
  const frontmatter: Record<string, string> = {};
  for (const line of normalized.slice(4, endIndex).split("\n")) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^["']|["']$/g, "");
    if (key) frontmatter[key] = value;
  }
  return { frontmatter, body: normalized.slice(endIndex + 4).trim() };
}

function skillDirName(modulePath: string): string {
  const segments = modulePath.split("/");
  return segments[segments.length - 2] ?? "";
}

/** Body with every {{snippet:...}} marker replaced by the referenced file in a python fence.
 * Unresolvable markers are left verbatim and reported by validateSkillRegistry, never thrown:
 * a broken skill must not take the whole client bundle down at import time. */
function interpolateSnippets(body: string, resources: ReadonlyMap<string, string>): string {
  return body.replace(SNIPPET_MARKER, (marker, path: string) => {
    const content = resources.get(path.trim());
    return content === undefined ? marker : `\`\`\`python\n${content.trimEnd()}\n\`\`\``;
  });
}

function buildSkills(): ChamferSkill[] {
  const resourcesByDir = new Map<string, Map<string, string>>();
  for (const [modulePath, content] of Object.entries(resourceFiles)) {
    // "./skills/<dir>/snippets/<file>.py" -> dir + "snippets/<file>.py"
    const match = /^\.\/skills\/([^/]+)\/(.+)$/.exec(modulePath);
    if (!match?.[1] || !match[2]) continue;
    const byPath = resourcesByDir.get(match[1]) ?? new Map<string, string>();
    byPath.set(match[2], content);
    resourcesByDir.set(match[1], byPath);
  }

  const skills: ChamferSkill[] = [];
  for (const [modulePath, content] of Object.entries(skillFiles)) {
    const dir = skillDirName(modulePath);
    const { frontmatter, body } = parseFrontmatter(content);
    const resources = resourcesByDir.get(dir) ?? new Map<string, string>();
    skills.push({
      name: frontmatter.name || dir,
      description: frontmatter.description ?? "",
      content: interpolateSnippets(body, resources),
      filePath: `skills/${dir}/SKILL.md`,
      resources,
    });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export const skills: readonly ChamferSkill[] = buildSkills();

export function findSkill(name: string): ChamferSkill | undefined {
  return skills.find((skill) => skill.name === name);
}

export function skillNames(): string[] {
  return skills.map((skill) => skill.name);
}

/**
 * The tier-1 catalog block for the system prompt: pi's agentskills.io-format
 * skill list, plus the adapter line binding it to load_skill (this runtime has
 * no file-read tool, so <location> paths are fetched through load_skill).
 */
export function skillCatalog(): string {
  if (skills.length === 0) return "";
  return [
    formatSkillsForSystemPrompt([...skills]),
    "",
    'In this runtime skill files are fetched with the load_skill tool, not a file reader: load_skill(name) returns the full SKILL.md, and load_skill(name, resource) returns a file the skill references by relative path (for example resource "snippets/example.py"). Load a skill before the first use of an operation it covers, and after a failure matching its description. A loaded skill stays in context for the whole conversation; do not load it twice.',
  ].join("\n");
}

/** Every skill body inlined, for the "full" (preloaded upper bound) ablation arm. */
export function allSkillsInlined(): string {
  return skills.map((skill) => formatSkillInvocation(skill)).join("\n\n");
}

/** The load_skill result payload for a skill body. */
export function skillBodyText(skill: ChamferSkill): string {
  return formatSkillInvocation(skill);
}

/** The load_skill result payload for a resource file. */
export function skillResourceText(skill: ChamferSkill, path: string, content: string): string {
  return `<skill-resource skill="${skill.name}" path="${path}">\n${content.trimEnd()}\n</skill-resource>`;
}

/** Prose word count of a body, excluding fenced code blocks. */
export function proseWordCount(body: string): number {
  const withoutCode = body.replace(/```[\s\S]*?```/g, " ");
  return withoutCode.split(/\s+/).filter(Boolean).length;
}

/**
 * Structural validation for every registered skill, mirroring pi's SKILL.md
 * diagnostics plus Chamfer's authoring rules. Enforced by vitest; returns
 * human-readable problems, empty when the registry is sound.
 */
export function validateSkillRegistry(): string[] {
  const problems: string[] = [];
  for (const [modulePath, content] of Object.entries(skillFiles)) {
    const dir = skillDirName(modulePath);
    const { frontmatter } = parseFrontmatter(content);
    if ((frontmatter.name || dir) !== dir) {
      problems.push(`${dir}: frontmatter name "${frontmatter.name}" does not match its folder`);
    }
  }
  const rawBodies = new Map<string, string>(
    Object.entries(skillFiles).map(([modulePath, content]) => [
      skillDirName(modulePath),
      parseFrontmatter(content).body,
    ]),
  );
  for (const skill of skills) {
    const label = skill.name;
    if (!NAME_PATTERN.test(skill.name) || skill.name.length > MAX_NAME_LENGTH) {
      problems.push(`${label}: invalid name (lowercase a-z, 0-9, single hyphens, max ${MAX_NAME_LENGTH})`);
    }
    if (!skill.description.trim()) problems.push(`${label}: description is required`);
    if (skill.description.length > MAX_DESCRIPTION_LENGTH) {
      problems.push(`${label}: description exceeds ${MAX_DESCRIPTION_LENGTH} characters`);
    }
    const unresolved = [...skill.content.matchAll(SNIPPET_MARKER)].map((match) => match[1]);
    for (const path of unresolved) problems.push(`${label}: unresolved snippet marker "${path}"`);
    const words = proseWordCount(skill.content);
    if (words > MAX_SKILL_PROSE_WORDS) {
      problems.push(`${label}: body has ${words} prose words (max ${MAX_SKILL_PROSE_WORDS}); split the skill`);
    }
    // Discoverability is judged on the raw authored body, where an interpolated
    // {{snippet:...}} marker still names its file.
    const rawBody = rawBodies.get(skill.filePath.split("/")[1] ?? "") ?? skill.content;
    for (const path of skill.resources.keys()) {
      if (!rawBody.includes(path)) {
        problems.push(`${label}: resource "${path}" is never referenced from the body, so the model cannot discover it`);
      }
    }
  }
  return problems;
}
