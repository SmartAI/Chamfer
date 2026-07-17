import { describe, expect, it } from "vitest";
import {
  findSkill,
  MAX_SKILL_PROSE_WORDS,
  proseWordCount,
  skillCatalog,
  skills,
  validateSkillRegistry,
} from "./skillRegistry";

describe("skill registry", () => {
  it("has no structural problems in any authored skill", () => {
    expect(validateSkillRegistry()).toEqual([]);
  });

  it("bundles the sweep-and-loft seed skill with interpolated snippets", () => {
    const skill = findSkill("sweep-and-loft");
    expect(skill).toBeDefined();
    expect(skill?.description).toContain("sweep");
    // Snippet markers resolved into fenced code carrying the pinned framing invariant.
    expect(skill?.content).toContain("Plane(origin=path @ 0, z_dir=path % 0)");
    expect(skill?.content).toContain("```python");
    expect(skill?.content).not.toContain("{{snippet:");
    // The diagnostic probe is a discoverable resource, referenced from the body.
    expect(skill?.resources.has("snippets/sweep_diagnose.py")).toBe(true);
    expect(skill?.content).toContain("snippets/sweep_diagnose.py");
  });

  it("keeps every skill inside the prose budget", () => {
    for (const skill of skills) {
      expect(proseWordCount(skill.content), skill.name).toBeLessThanOrEqual(MAX_SKILL_PROSE_WORDS);
    }
  });

  it("emits an agentskills.io catalog bound to load_skill", () => {
    const catalog = skillCatalog();
    expect(catalog).toContain("<available_skills>");
    expect(catalog).toContain("<location>skills/sweep-and-loft/SKILL.md</location>");
    expect(catalog).toContain('load_skill(name, resource)');
  });

  it("lists topology recovery recipes by the failure symptoms an agent sees", () => {
    const catalog = skillCatalog();
    expect(catalog).toContain("recover-disjoint-solids");
    expect(catalog).toContain("bodies: expected 1, found 3");
    expect(catalog).toContain("recover-coincident-booleans");
    expect(catalog).toContain("coincident-face");
    expect(catalog).toContain("recover-collapsing-lofts");
    expect(catalog).toContain("tessellation failure");
  });

  it("counts prose without charging for code blocks", () => {
    expect(proseWordCount("one two\n```python\nthree four five six\n```\nseven")).toBe(3);
  });

  it("keeps shared CAD methods reusable and environment API examples isolated", () => {
    const localCatalog = skillCatalog("build123d");
    const fusionCatalog = skillCatalog("fusion");

    expect(localCatalog).toContain("design-intent");
    expect(fusionCatalog).toContain("design-intent");
    expect(localCatalog).toContain("sweep-and-loft");
    expect(localCatalog).not.toContain("fusion-parametric-features");
    expect(fusionCatalog).toContain("fusion-parametric-features");
    expect(fusionCatalog).not.toContain("sweep-and-loft");
    expect(findSkill("fusion-parametric-features", "build123d")).toBeUndefined();
    expect(findSkill("sweep-and-loft", "fusion")).toBeUndefined();
  });
});
