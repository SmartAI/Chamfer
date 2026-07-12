import { describe, expect, it } from "vitest";
import { assembleAgentPrompt, build123dCoreSkill, DEFAULT_SKILL_MODE } from "./build123dSkill";
import { skills } from "./skillRegistry";

describe("build123d skill prompt assembly", () => {
  it("layers the four ablation treatments in increasing context cost", () => {
    const runtimePrompt = "runtime contract";

    const none = assembleAgentPrompt(runtimePrompt, { skill: "none" });
    const core = assembleAgentPrompt(runtimePrompt, { skill: "core" });
    const catalog = assembleAgentPrompt(runtimePrompt, { skill: "catalog" });
    const full = assembleAgentPrompt(runtimePrompt, { skill: "full" });

    expect(none).toBe(runtimePrompt);
    expect(core).toBe(`${runtimePrompt}\n\n${build123dCoreSkill}`);
    expect(catalog).toContain(build123dCoreSkill);
    expect(catalog).toContain("<available_skills>");
    expect(catalog).toContain("load_skill");
    expect(full).toContain(build123dCoreSkill);
    expect(full).toContain("## Preloaded modeling skills");
    expect(none.length).toBeLessThan(core.length);
    expect(core.length).toBeLessThan(catalog.length);
    expect(catalog.length).toBeLessThan(full.length);
  });

  it("defaults to progressive disclosure via the catalog", () => {
    expect(DEFAULT_SKILL_MODE).toBe("catalog");
  });

  it("lists every registered skill in the catalog and inlines every body in full mode", () => {
    const catalog = assembleAgentPrompt("p", { skill: "catalog" });
    const full = assembleAgentPrompt("p", { skill: "full" });
    expect(skills.length).toBeGreaterThan(0);
    for (const skill of skills) {
      expect(catalog).toContain(`<name>${skill.name}</name>`);
      expect(full).toContain(skill.content);
    }
    // The catalog must stay an index: descriptions only, never full bodies.
    for (const skill of skills) expect(catalog).not.toContain(skill.content);
  });

  it("keeps the core treatment aligned on the high-risk invariants", () => {
    expect(build123dCoreSkill).toContain("Plane(origin=path @ 0, z_dir=path % 0)");
    expect(build123dCoreSkill).toContain("After two failures");
    expect(build123dCoreSkill).toContain("search_docs");
  });
});
