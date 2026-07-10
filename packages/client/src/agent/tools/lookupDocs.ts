import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

export const DOC_TOPICS = [
  "allowed-api",
  "sketch-extrude",
  "booleans",
  "fillets-chamfers",
  "holes-counterbores",
  "selectors-measurements",
  "assemblies-compounds",
  "common-tracebacks",
] as const;

const topicSet = new Set<string>(DOC_TOPICS);
const parameters = Type.Object({
  topic: Type.String({ description: "One exact build123d documentation topic from the available topic list." }),
});

export function createLookupDocsTool(): AgentTool<typeof parameters, { topic: string }> {
  const available = DOC_TOPICS.join(", ");
  return {
    name: "lookup_docs",
    label: "Look up build123d docs",
    description: `Read a bundled build123d reference topic before guessing at an API. Available topics: ${available}.`,
    parameters,
    execute: async (_toolCallId, { topic }) => {
      if (!topicSet.has(topic)) {
        return {
          content: [{ type: "text", text: `Unknown topic "${topic}". Available topics: ${available}.` }],
          details: { topic },
        };
      }
      const response = await fetch(`/docs/${topic}.md`);
      if (!response.ok) throw new Error(`Failed to load documentation topic "${topic}": ${response.status}`);
      return {
        content: [{ type: "text", text: await response.text() }],
        details: { topic },
      };
    },
  };
}
