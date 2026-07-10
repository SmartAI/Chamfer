import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLookupDocsTool, DOC_TOPICS } from "./lookupDocs";

describe("lookup_docs tool", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns build123d reference markdown for a known topic", async () => {
    const markdown = "# Sketch and extrude\n\n```python\nresult = extrude(Circle(10), amount=5)\n```";
    const fetchMock = vi.fn().mockResolvedValue(new Response(markdown, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const tool = createLookupDocsTool();

    const result = await tool.execute("lookup-1", { topic: "sketch-extrude" });

    expect(fetchMock).toHaveBeenCalledWith("/docs/sketch-extrude.md");
    expect(result.content[0]).toEqual({ type: "text", text: expect.stringContaining("```python") });
    expect(tool.description).toContain("sketch-extrude");
  });

  it("returns the topic list instead of throwing for an unknown topic", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const tool = createLookupDocsTool();

    const result = await tool.execute("lookup-2", { topic: "invented-api" });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.content[0]).toEqual({
      type: "text",
      text: expect.stringMatching(/Unknown topic.*sketch-extrude/s),
    });
  });
});

describe("bundled docs stay in sync with DOC_TOPICS", () => {
  // Vitest runs with the workspace package as cwd (import.meta.url is unusable
  // here: the jsdom pipeline rewrites module URLs to a non-file scheme).
  const docsDir = join(process.cwd(), "public", "docs");

  it("topics.json deep-equals DOC_TOPICS", () => {
    const topics = JSON.parse(readFileSync(join(docsDir, "topics.json"), "utf8")) as unknown;
    expect(topics).toEqual([...DOC_TOPICS]);
  });

  it("every topic has a markdown file containing a python example", () => {
    for (const topic of DOC_TOPICS) {
      const file = join(docsDir, `${topic}.md`);
      expect(existsSync(file), `${topic}.md is missing`).toBe(true);
      expect(readFileSync(file, "utf8"), `${topic}.md has no python fence`).toContain("```python");
    }
  });
});
