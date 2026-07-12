import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import MiniSearch from "minisearch";
import { describe, expect, it } from "vitest";
import { DOC_INDEX_OPTIONS, DOC_SEARCH_OPTIONS } from "../../src/agent/docSearchConfig.ts";

const evalDir = dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(readFileSync(join(evalDir, "cases.json"), "utf8"));
const asset = JSON.parse(readFileSync(join(evalDir, "../../public/docs/build123d-index.json"), "utf8"));
const index = MiniSearch.loadJS(asset.index, DOC_INDEX_OPTIONS);

describe("build123d documentation retrieval eval", () => {
  it.each(cases)("returns $expected_section in the top 3 for '$query'", ({ query, expected_section }) => {
    const topThree = index.search(query, DOC_SEARCH_OPTIONS).slice(0, 3).map((result) => String(result.id));

    expect(topThree, `ranked sections for ${JSON.stringify(query)}`).toContain(expected_section);
  });
});
