import { describe, expect, it } from "vitest";
import { documentationExcerpts } from "./documentation";

describe("documentationExcerpts", () => {
  it("projects version-dependent adapter JSON into bounded scalar excerpts", () => {
    const excerpts = documentationExcerpts({
      success: true,
      classes: [{
        name: "adsk.fusion.ExtrudeFeatureInput",
        signature: "setDistanceExtent(distance: adsk.core.ValueInput)",
        internal: { rawTransportFrame: { nested: Array.from({ length: 20 }, (_, index) => `item-${index}`) } },
      }],
    });

    expect(excerpts).toContain("name: adsk.fusion.ExtrudeFeatureInput | signature: setDistanceExtent(distance: adsk.core.ValueInput)");
    expect(JSON.stringify(excerpts)).not.toContain("rawTransportFrame");
    expect(JSON.stringify(excerpts)).not.toContain("item-0");
    expect(excerpts.length).toBeLessThanOrEqual(8);
    expect(excerpts.every((excerpt) => excerpt.length <= 600)).toBe(true);
  });

  it("redacts credentials, network locations, and Fusion filenames from otherwise relevant fields", () => {
    const excerpts = documentationExcerpts({ classes: [{
      name: "adsk.fusion.Design",
      description: "Authorization: Bearer top-secret. Example https://host/private and unrelated.f3d",
    }] });
    const serialized = JSON.stringify(excerpts);
    expect(serialized).not.toContain("top-secret");
    expect(serialized).not.toContain("https://host/private");
    expect(serialized).not.toContain("unrelated.f3d");
  });
});
