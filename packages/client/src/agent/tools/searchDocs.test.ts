import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import MiniSearch from "minisearch";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DOC_INDEX_OPTIONS } from "../docSearchConfig";
import { createSearchDocsTool } from "./searchDocs";

function indexResponse() {
  const index = new MiniSearch(DOC_INDEX_OPTIONS);
  index.addAll([
    {
      section_id: "introductory-examples#24-loft",
      title: "24. Loft",
      body: "Loft joins dissimilar cross sections on parallel workplanes.",
      api_names: "loft BuildSketch Plane",
      synonyms: "blend transition",
    },
    {
      section_id: "introductory-examples#23-revolve",
      title: "23. Revolve",
      body: "Revolve a connected sketch around an axis.",
      api_names: "revolve Axis",
      synonyms: "turn lathe",
    },
  ]);
  return new Response(
    JSON.stringify({
      format_version: 1,
      attribution: {
        project: "build123d",
        version: "0.11.1",
        source: "https://github.com/gumyr/build123d/tree/v0.11.1/docs",
        license: "Apache-2.0",
      },
      index: index.toJSON(),
    }),
    { status: 200 },
  );
}

describe("search_docs tool", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns ranked titled sections and structured retrieval details", async () => {
    const fetchMock = vi.fn().mockResolvedValue(indexResponse());
    vi.stubGlobal("fetch", fetchMock);
    const tool = createSearchDocsTool();

    const result = await tool.execute("search-1", { query: "loft between cross sections" });

    expect(fetchMock).toHaveBeenCalledWith("/docs/build123d-index.json");
    expect(result.content[0]).toEqual({
      type: "text",
      text: expect.stringMatching(/# build123d documentation search.*## 24\. Loft.*cross sections/s),
    });
    expect(result.details).toEqual({
      query: "loft between cross sections",
      results: [
        {
          section_id: "introductory-examples#24-loft",
          score: expect.any(Number),
        },
      ],
    });
    expect(tool.description).toMatch(/API names.*operation verbs.*traceback/i);
  });

  it("returns an empty titled result that invites reformulation", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(indexResponse()));
    const tool = createSearchDocsTool();

    const result = await tool.execute("search-2", { query: "zzzzquuxnotacapterm" });

    expect(result.content[0]).toEqual({
      type: "text",
      text: expect.stringMatching(/^# build123d documentation search.*No matching sections.*Reformulate/is),
    });
    expect(result.details).toEqual({ query: "zzzzquuxnotacapterm", results: [] });
  });

  it("retries the index load after a failed fetch instead of caching the rejection", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValue(indexResponse());
    vi.stubGlobal("fetch", fetchMock);
    const tool = createSearchDocsTool();

    await expect(tool.execute("search-fail", { query: "loft" })).rejects.toThrow("network down");

    const result = await tool.execute("search-retry", { query: "loft between cross sections" });
    expect(result.details.results.length).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns the loft teaching section in the top 3 from the committed index", async () => {
    const asset = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../../public/docs/build123d-index.json"),
      "utf8",
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(asset, { status: 200 })));
    const tool = createSearchDocsTool();

    const result = await tool.execute("search-3", { query: "loft between cross sections" });

    expect(result.details.results.slice(0, 3).map(({ section_id }) => section_id)).toContain(
      "introductory-examples#24-loft",
    );
  });
});
