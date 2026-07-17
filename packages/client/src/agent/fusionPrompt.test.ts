import { describe, expect, it } from "vitest";
import { FUSION_FOUNDATION_SKILL_VERSION, fusionRuntimePrompt, fusionSkillAttribution, fusionSkillCatalogMetadata } from "./fusionPrompt";

describe("Fusion prompt assembly", () => {
  it("starts every run with the versioned reviewed foundation and a Fusion-only progressive catalog", () => {
    expect(fusionRuntimePrompt).toContain(`Fusion foundation skill ${FUSION_FOUNDATION_SKILL_VERSION}`);
    for (const topic of ["inspection", "units", "document", "revision", "action", "verification", "recovery"]) {
      expect(fusionRuntimePrompt.toLowerCase()).toContain(topic);
    }
    expect(fusionRuntimePrompt).toContain("fusion-parametric-features");
    expect(fusionRuntimePrompt).toContain("design-intent");
    expect(fusionRuntimePrompt).not.toContain("sweep-and-loft");
    expect(fusionRuntimePrompt).not.toContain("Plane(origin=");
    expect(fusionRuntimePrompt).toContain("register_entity");
    expect(fusionRuntimePrompt).toContain("destructive-rebuild");
    expect(fusionRuntimePrompt).toContain("manual edit");
  });

  it("publishes exact foundation and specialized versions for future action and evaluation records", () => {
    expect(fusionSkillCatalogMetadata.foundation).toEqual({ name: "fusion-foundation", version: "1.9.0" });
    expect(fusionSkillCatalogMetadata.available).toEqual(expect.arrayContaining([
      { name: "fusion-parametric-features", version: "1.12.0" },
      { name: "design-intent", version: "1.0.0" },
    ]));
  });

  it("keeps document lifecycle authority outside the model tool catalog", () => {
    expect(fusionRuntimePrompt).toContain("Modeling authority never performs or infers Save");
    expect(fusionRuntimePrompt).not.toContain("save_fusion");
  });

  it("attributes only the specialized versions actually loaded in the persisted transcript", () => {
    const attribution = fusionSkillAttribution([
      { role: "toolResult", toolName: "load_skill", isError: false, details: { skill: "design-intent", version: "1.0.0", loaded: true } },
      { role: "toolResult", toolName: "load_skill", isError: false, details: { skill: "unused", version: "9.9.9" } },
    ]);
    expect(attribution).toEqual({
      foundation: { name: "fusion-foundation", version: "1.9.0" },
      loaded: [{ name: "design-intent", version: "1.0.0" }],
    });
  });
});
