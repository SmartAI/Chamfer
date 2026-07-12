import { allSkillsInlined, skillCatalog } from "./skillRegistry";

/**
 * Ablation treatments for the build123d skill layer, in increasing context cost:
 * - "none": runtime contract only.
 * - "core": + the always-on invariant summary below.
 * - "catalog": + the skill catalog (progressive disclosure via load_skill) - the default.
 * - "full": + every skill body inlined; the preloaded upper bound "catalog" is measured against.
 */
export type Build123dSkillMode = "none" | "core" | "catalog" | "full";

export const DEFAULT_SKILL_MODE: Build123dSkillMode = "catalog";

// This intentionally lossy summary is a distinct ablation treatment. Tests pin
// the high-risk sweep and retrieval invariants. Deeper per-topic pedagogy lives
// in skills/<name>/SKILL.md and reaches the model through the catalog + load_skill.
export const build123dCoreSkill = `## build123d 0.11.1 Core Skill

Choose the dominant form before details; parameterize dimensions; resolve profiles in 2D; fuse overlapping additive material; cut shared holes after fusion; apply fillets and chamfers last.
Sketch coordinates are local to their workplane. Make datums and alignment explicit; global \`translate\` is not a local-plane operation.
For sweep, the profile must lie at the path start on \`Plane(origin=path @ 0, z_dir=path % 0)\`. Verify the sweep alone before adding features.
Use builder pending objects or explicit algebra consistently. Select topology geometrically, never by unstable raw indices.
After an API, workplane, sweep, loft, selector, or repeated boolean failure, call \`search_docs\`. After two failures in one category, run a minimal diagnostic probe before rewriting the full model.`;

export function assembleAgentPrompt(runtimePrompt: string, options: { skill: Build123dSkillMode }): string {
  switch (options.skill) {
    case "none":
      return runtimePrompt;
    case "core":
      return `${runtimePrompt}\n\n${build123dCoreSkill}`;
    case "catalog": {
      const catalog = skillCatalog();
      return catalog
        ? `${runtimePrompt}\n\n${build123dCoreSkill}\n\n${catalog}`
        : `${runtimePrompt}\n\n${build123dCoreSkill}`;
    }
    case "full": {
      const inlined = allSkillsInlined();
      return inlined
        ? `${runtimePrompt}\n\n${build123dCoreSkill}\n\n## Preloaded modeling skills\n\n${inlined}`
        : `${runtimePrompt}\n\n${build123dCoreSkill}`;
    }
  }
}
