import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { CadEnvironment } from "@chamfer/shared";
import { findSkill, skillBodyText, skillNames, skillResourceText } from "../skillRegistry";

const parameters = Type.Object({
  name: Type.String({
    description: "Exact skill name from the available_skills list in the system prompt.",
  }),
  resource: Type.Optional(
    Type.String({
      description:
        'Skill-relative path of a resource file the skill references (for example "snippets/example.py"). Omit to load the skill itself.',
    }),
  ),
});

export interface LoadSkillDetails {
  skill: string;
  version?: string;
  resource?: string;
  /** True when this call returned an already-in-context notice instead of the payload. */
  deduped?: boolean;
}

/** True for a successful load_skill tool result (deduped notices included). */
export function isSkillLoadResult(message: unknown): message is { details: LoadSkillDetails } {
  if (typeof message !== "object" || message === null) return false;
  const m = message as {
    role?: unknown;
    toolName?: unknown;
    isError?: unknown;
    details?: { skill?: unknown; loaded?: unknown };
  };
  return (
    m.role === "toolResult" &&
    m.toolName === "load_skill" &&
    m.isError !== true &&
    typeof m.details?.skill === "string" &&
    m.details.loaded === true
  );
}

/** Stable identity for one loaded payload (skill body, or one resource of it). */
export function skillLoadKey(details: { skill: string; resource?: string }): string {
  return details.resource ? `${details.skill} ${details.resource}` : details.skill;
}

/** Keys of every payload already delivered to the model, in transcript order. */
export function loadedSkillKeys(messages: readonly unknown[]): Set<string> {
  const keys = new Set<string>();
  for (const message of messages) {
    if (!isSkillLoadResult(message)) continue;
    const details = (message as { details: LoadSkillDetails }).details;
    if (!details.deduped) keys.add(skillLoadKey(details));
  }
  return keys;
}

/**
 * The tier-2 fetch of the skill design: returns a full SKILL.md body (or one of
 * its resource files) by exact name. Loads are idempotent - the transcript is
 * scanned on every call, so a repeat load returns a one-line notice and the
 * pinned copy stays canonical across page reloads and compaction.
 *
 * `details.loaded: true` marks results that must survive compaction; the
 * details payload (not the text) is the contract with contextPolicy.ts.
 */
export function createLoadSkillTool(deps: {
  cadEnvironment?: CadEnvironment;
  getMessages: () => readonly unknown[];
}): AgentTool<typeof parameters, LoadSkillDetails & { loaded?: boolean }> {
  return {
    name: "load_skill",
    label: "Load CAD skill",
    description:
      `Load a ${deps.cadEnvironment === "fusion" ? "Fusion or shared CAD-method" : "build123d or shared CAD-method"} skill from the available_skills list, or one resource file it references. The content arrives once and then stays available for the whole conversation.`,
    parameters,
    execute: async (_toolCallId, { name, resource }) => {
      const environment = deps.cadEnvironment ?? "build123d";
      const skill = findSkill(name.trim(), environment);
      if (!skill) {
        return {
          content: [
            {
              type: "text",
              text: `Unknown skill "${name}". Available skills: ${skillNames(environment).join(", ")}.`,
            },
          ],
          details: { skill: name },
        };
      }

      const resourcePath = resource?.trim();
      let content: string | undefined;
      if (resourcePath) {
        content = skill.resources.get(resourcePath);
        if (content === undefined) {
          const available = [...skill.resources.keys()];
          return {
            content: [
              {
                type: "text",
                text:
                  `Skill "${skill.name}" has no resource "${resourcePath}". ` +
                  (available.length > 0 ? `Available resources: ${available.join(", ")}.` : "It has no resource files."),
              },
            ],
            details: { skill: skill.name, resource: resourcePath },
          };
        }
      }

      const version = skill.version === "unversioned" ? {} : { version: skill.version };
      const details: LoadSkillDetails = resourcePath
        ? { skill: skill.name, ...version, resource: resourcePath }
        : { skill: skill.name, ...version };
      if (loadedSkillKeys(deps.getMessages()).has(skillLoadKey(details))) {
        const label = resourcePath ? `Resource "${resourcePath}" of skill "${skill.name}"` : `Skill "${skill.name}"`;
        return {
          content: [{ type: "text", text: `${label} is already in context; re-read it above instead of reloading.` }],
          details: { ...details, deduped: true, loaded: true },
        };
      }

      return {
        content: [
          {
            type: "text",
            text: resourcePath && content !== undefined ? skillResourceText(skill, resourcePath, content) : skillBodyText(skill),
          },
        ],
        details: { ...details, loaded: true },
      };
    },
  };
}
