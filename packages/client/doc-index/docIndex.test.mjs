import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import MiniSearch from "minisearch";
import { describe, expect, it } from "vitest";
import { chunkRstDocument, INDEX_OPTIONS } from "./docIndex.mjs";
import { DOC_SEARCH_OPTIONS } from "../src/agent/docSearchConfig.ts";

describe("build123d documentation chunking", () => {
  it("keeps a code example with its heading section", () => {
    const source = `Guide
=====

Overview text.

Loft between sections
---------------------

Use :func:\`~operations_part.loft\` for cross sections.

.. code-block:: python

    result = loft(sections)

Next operation
--------------

Use extrude here.
`;

    const chunks = chunkRstDocument("guide.rst", source);
    const loft = chunks.find((chunk) => chunk.title === "Loft between sections");
    const next = chunks.find((chunk) => chunk.title === "Next operation");

    expect(loft?.body).toContain("result = loft(sections)");
    expect(loft?.api_names).toContain("loft");
    expect(next?.body).not.toContain("result = loft(sections)");
  });

  it("gives every chunk stable required fields", () => {
    const chunks = chunkRstDocument("objects.rst", "Objects\n=======\n\nHelix\n-----\n\n``Helix(pitch, height, radius)``\n");

    expect(chunks).toEqual([
      expect.objectContaining({
        section_id: "objects#objects",
        title: "Objects",
        body: expect.any(String),
        api_names: expect.any(Array),
        synonyms: expect.any(Array),
      }),
      expect.objectContaining({
        section_id: "objects#helix",
        title: "Helix",
        api_names: expect.arrayContaining(["Helix"]),
      }),
    ]);
  });

  it("does not treat heading-like lines inside code as sections", () => {
    const source = `Example
=======

.. code-block:: python

    Generated profile
    =================
    result = Box(1, 2, 3)
`;

    const chunks = chunkRstDocument("example.rst", source);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].body).toContain("Generated profile\n    =================");
  });
});

describe("generated build123d documentation index", () => {
  const asset = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../public/docs/build123d-index.json"), "utf8"));
  const index = MiniSearch.loadJS(asset.index, INDEX_OPTIONS);

  it("contains the pinned full corpus with attribution and required chunk fields", () => {
    expect(asset.attribution).toEqual({
      project: "build123d",
      version: "0.11.1",
      source: "https://github.com/gumyr/build123d/tree/v0.11.1/docs",
      license: "Apache-2.0",
    });
    expect(index.documentCount).toBeGreaterThan(400);
    const loft = index.getStoredFields("introductory-examples#24-loft");
    expect(loft).toEqual(expect.objectContaining({
      title: "24. Loft",
      body: expect.stringContaining(".. code-block:: build123d"),
      api_names: expect.stringContaining("loft"),
      synonyms: expect.stringContaining("cross sections"),
    }));
    expect(loft?.body).not.toContain("literalinclude");
    expect(JSON.stringify(asset)).not.toContain("\u2014");
  });

  it.each([
    ["loft usage", "introductory-examples#24-loft"],
    ["sweep usage", "introductory-examples#14-position-on-a-line-with-and-introduce-sweep"],
    ["revolve usage", "introductory-examples#23-revolve"],
    ["spline usage", "introductory-examples#12-defining-an-edge-with-a-spline"],
    ["helix usage", "objects#1d-objects"],
  ])("ranks the teaching section first for %s", (query, expectedSection) => {
    const results = index.search(query, DOC_SEARCH_OPTIONS);

    expect(results[0]?.id).toBe(expectedSection);
  });
});
