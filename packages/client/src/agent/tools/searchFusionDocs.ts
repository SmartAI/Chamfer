import type { AgentTool } from "@earendil-works/pi-agent-core";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { FusionDocumentationQueryDto, FusionDocumentationResultDto } from "@chamfer/shared";

const parameters = Type.Object({
  query: Type.String({ description: "Exact installed Fusion class or member name to look up." }),
  category: StringEnum(["class", "member"], { description: "Whether the query names a class or member." }),
  namespace: StringEnum(["adsk.core", "adsk.fusion"], { description: "Installed Fusion API namespace to search." }),
  owner: Type.Optional(Type.String({ description: "For member lookup, the exact fully-qualified owning class, such as adsk.fusion.ExtrudeFeatureInput." })),
});

export interface SearchFusionDocsDetails {
  query: string;
  source: FusionDocumentationResultDto["source"];
  mutated: false;
}

export function createSearchFusionDocsTool(deps: {
  search: (input: FusionDocumentationQueryDto) => Promise<FusionDocumentationResultDto>;
}): AgentTool<typeof parameters, SearchFusionDocsDetails> {
  return {
    name: "search_fusion_docs",
    label: "Search installed Fusion API",
    description: "Search the exact API reference installed with this Fusion version. Use before guessing at a class, member, signature, or version-specific behavior. This capability is read-only.",
    parameters,
    execute: async (_toolCallId, input) => {
      const result = await deps.search(input as FusionDocumentationQueryDto);
      const heading = `# Installed Fusion ${result.source.fusionVersion} API: ${result.query}`;
      return {
        content: [{ type: "text", text: [heading, `Source: ${result.source.mcpServer}; MCP ${result.source.mcpProtocolVersion}`, ...result.excerpts.map((item) => `- ${item}`)].join("\n") }],
        details: { query: result.query, source: result.source, mutated: false },
      };
    },
  };
}
