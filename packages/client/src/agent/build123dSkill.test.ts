import { describe, expect, it } from "vitest";
import { assembleAgentPrompt, build123dCoreSkill, build123dSkill, build123dSkillSources } from "./build123dSkill";

describe("build123d skill prompt assembly", () => {
  it("can ablate the skill while preserving the runtime prompt", () => {
    const runtimePrompt = "runtime contract";

    expect(assembleAgentPrompt(runtimePrompt, { skill: "none" })).toBe(runtimePrompt);
    expect(assembleAgentPrompt(runtimePrompt, { skill: "core" })).toContain("build123d 0.11.1 Core Skill");
    expect(assembleAgentPrompt(runtimePrompt, { skill: "full" })).toBe(`${runtimePrompt}\n\n${build123dSkill}`);
  });

  it("teaches the pinned sweep framing invariant without MCP-only APIs", () => {
    expect(build123dSkill).toContain("build123d 0.11.1");
    expect(build123dSkill).toContain("Plane(origin=path @ 0, z_dir=path % 0)");
    expect(build123dSkill).toContain("profile must lie at the start of the path");
    for (const unavailable of ["reset()", "show(", "measure(", "validate(", "save_snapshot(", "import OCP"]) {
      expect(build123dSkill).not.toContain(unavailable);
    }
  });

  it("records pinned official provenance for every vertical section", () => {
    expect(build123dSkillSources).toHaveLength(6);
    expect(build123dSkillSources.every((source) => source.url.includes("github.com/gumyr/build123d/blob/v0.11.1/docs/"))).toBe(true);
  });

  it("keeps the core treatment aligned on the high-risk invariants", () => {
    expect(build123dCoreSkill).toContain("Plane(origin=path @ 0, z_dir=path % 0)");
    expect(build123dCoreSkill).toContain("After two failures");
    expect(build123dCoreSkill).toContain("search_docs");
  });
});
