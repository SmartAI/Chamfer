import { describe, expect, it, vi } from "vitest";
import { createSearchFusionDocsTool } from "./searchFusionDocs";

describe("search_fusion_docs tool", () => {
  it("returns version-matched installed guidance with source identity and no mutation authority", async () => {
    const search = vi.fn().mockResolvedValue({
      query: "setDistanceExtent",
      excerpts: ["adsk.fusion.ExtrudeFeatureInput.setDistanceExtent(distance: ValueInput)"],
      source: {
        kind: "installed-fusion-api",
        fusionVersion: "2704.1.23",
        mcpProtocolVersion: "2025-11-25",
        mcpServer: "MCP Server Adapter 1.0.0",
      },
    });
    const tool = createSearchFusionDocsTool({ search });

    const result = await tool.execute("docs-1", {
      query: "setDistanceExtent",
      category: "member",
      namespace: "adsk.fusion",
      owner: "adsk.fusion.ExtrudeFeatureInput",
    }, undefined as never, undefined as never);

    expect(tool.name).toBe("search_fusion_docs");
    expect(JSON.stringify(tool)).not.toContain("fusion_mcp_read");
    expect((result.content[0] as { text: string }).text).toContain("Fusion 2704.1.23");
    expect((result.content[0] as { text: string }).text).toContain("setDistanceExtent");
    expect(result.details).toMatchObject({ source: { fusionVersion: "2704.1.23" }, mutated: false });
  });
});
