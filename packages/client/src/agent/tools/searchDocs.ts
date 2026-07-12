import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import MiniSearch, { type SearchResult } from "minisearch";
import { DOC_INDEX_OPTIONS, DOC_SEARCH_OPTIONS } from "../docSearchConfig";

const INDEX_URL = "/docs/build123d-index.json";
const TOP_K = 5;
const MAX_SECTION_CHARS = 6_000;
const parameters = Type.Object({
  query: Type.String({
    description: "Short keyword query using API names, operation verbs, or raw traceback text.",
  }),
});

interface SearchDetails {
  query: string;
  results: Array<{ section_id: string; score: number }>;
}

function resultText(query: string, results: SearchResult[]): string {
  const heading = `# build123d documentation search: "${query}"`;
  if (results.length === 0) {
    return `${heading}\n\nNo matching sections. Reformulate with an API name, operation verb, or raw traceback text.`;
  }
  const sections = results.map((result) => {
    const body = String(result.body ?? "");
    const displayed = body.length > MAX_SECTION_CHARS ? `${body.slice(0, MAX_SECTION_CHARS)}\n\n[Section truncated]` : body;
    return `## ${String(result.title)}\nSection ID: ${String(result.id)}\n\n${displayed}`;
  });
  return `${heading}\n\n${sections.join("\n\n")}`;
}

export function createSearchDocsTool(): AgentTool<typeof parameters, SearchDetails> {
  let indexPromise: Promise<MiniSearch> | undefined;
  const loadIndex = () => {
    // A rejected load must not stick: drop the cached promise so the next call
    // retries instead of failing every future search on one transient fetch error.
    indexPromise ??= fetch(INDEX_URL)
      .then(async (response) => {
        if (!response.ok) throw new Error(`Failed to load build123d documentation index: ${response.status}`);
        const asset = await response.json() as { index?: unknown };
        if (!asset.index) throw new Error("Build123d documentation index is malformed");
        return MiniSearch.loadJS(asset.index as Parameters<typeof MiniSearch.loadJS>[0], DOC_INDEX_OPTIONS);
      })
      .catch((error: unknown) => {
        indexPromise = undefined;
        throw error;
      });
    return indexPromise;
  };

  return {
    name: "search_docs",
    label: "Search build123d docs",
    description:
      "Search the full bundled build123d documentation. Use a short keyword query made of API names, operation verbs, or raw traceback text. Read the titled results, and reformulate when none match.",
    parameters,
    execute: async (_toolCallId, { query }) => {
      const normalizedQuery = query.trim();
      const index = await loadIndex();
      const results = normalizedQuery
        ? index.search(normalizedQuery, DOC_SEARCH_OPTIONS).slice(0, TOP_K)
        : [];
      return {
        content: [{ type: "text", text: resultText(normalizedQuery, results) }],
        details: {
          query: normalizedQuery,
          results: results.map((result) => ({ section_id: String(result.id), score: result.score })),
        },
      };
    },
  };
}
