import { describe, expect, it } from "vitest";
import { createLoadSkillTool, isSkillLoadResult, loadedSkillKeys, skillLoadKey } from "./loadSkill";

function loadResult(details: object) {
  return { role: "toolResult", toolName: "load_skill", content: [{ type: "text", text: "x" }], details };
}

async function execute(tool: ReturnType<typeof createLoadSkillTool>, args: { name: string; resource?: string }) {
  return await tool.execute("call-1", args as never, undefined as never, undefined as never);
}

describe("load_skill tool", () => {
  it("returns the full skill body wrapped in the pi skill block", async () => {
    const tool = createLoadSkillTool({ getMessages: () => [] });
    const result = await execute(tool, { name: "sweep-and-loft" });

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('<skill name="sweep-and-loft" location="skills/sweep-and-loft/SKILL.md">');
    expect(text).toContain("Plane(origin=path @ 0, z_dir=path % 0)");
    expect(result.details).toEqual({ skill: "sweep-and-loft", loaded: true });
  });

  it("returns a referenced resource file by skill-relative path", async () => {
    const tool = createLoadSkillTool({ getMessages: () => [] });
    const result = await execute(tool, { name: "sweep-and-loft", resource: "snippets/sweep_diagnose.py" });

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('<skill-resource skill="sweep-and-loft" path="snippets/sweep_diagnose.py">');
    expect(text).toContain("start tangent");
    expect(result.details).toEqual({ skill: "sweep-and-loft", resource: "snippets/sweep_diagnose.py", loaded: true });
  });

  it("dedupes a repeat load into a short notice, keyed separately per resource", async () => {
    const messages = [loadResult({ skill: "sweep-and-loft", loaded: true })];
    const tool = createLoadSkillTool({ getMessages: () => messages });

    const repeat = await execute(tool, { name: "sweep-and-loft" });
    expect((repeat.content[0] as { text: string }).text).toContain("already in context");
    expect(repeat.details).toEqual({ skill: "sweep-and-loft", deduped: true, loaded: true });

    // A resource of the same skill is a distinct payload and still loads in full.
    const resource = await execute(tool, { name: "sweep-and-loft", resource: "snippets/sweep_diagnose.py" });
    expect(resource.details).toEqual({ skill: "sweep-and-loft", resource: "snippets/sweep_diagnose.py", loaded: true });
  });

  it("lists what exists on an unknown skill or resource instead of erroring", async () => {
    const tool = createLoadSkillTool({ getMessages: () => [] });

    const unknownSkill = await execute(tool, { name: "nonexistent" });
    expect((unknownSkill.content[0] as { text: string }).text).toContain("sweep-and-loft");
    expect((unknownSkill.content[0] as { text: string }).text).toContain("surgical-edits");
    expect(isSkillLoadResult({ ...loadResult(unknownSkill.details), details: unknownSkill.details })).toBe(false);

    const unknownResource = await execute(tool, { name: "sweep-and-loft", resource: "snippets/missing.py" });
    expect((unknownResource.content[0] as { text: string }).text).toContain("Available resources:");
  });

  it("identifies durable load results and their payload keys", () => {
    expect(isSkillLoadResult(loadResult({ skill: "sweep-and-loft", loaded: true }))).toBe(true);
    expect(isSkillLoadResult(loadResult({ skill: "sweep-and-loft" }))).toBe(false);
    expect(isSkillLoadResult({ ...loadResult({ skill: "s", loaded: true }), isError: true })).toBe(false);
    expect(isSkillLoadResult({ role: "toolResult", toolName: "search_docs", details: { skill: "s", loaded: true } })).toBe(false);

    expect(skillLoadKey({ skill: "a" })).not.toBe(skillLoadKey({ skill: "a", resource: "snippets/x.py" }));
    const keys = loadedSkillKeys([
      loadResult({ skill: "a", loaded: true }),
      loadResult({ skill: "a", deduped: true, loaded: true }),
      loadResult({ skill: "b", resource: "snippets/x.py", loaded: true }),
    ]);
    expect(keys).toEqual(new Set(["a", "b snippets/x.py"]));
  });
});
