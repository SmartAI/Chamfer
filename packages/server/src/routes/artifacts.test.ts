import { describe, expect, it } from "vitest";
import { createApp } from "../app";
import { openDb } from "../db";

describe("artifacts routes", () => {
  it("creates incrementing versions and lists them oldest first", async () => {
    const app = createApp(openDb(":memory:"));
    const conversation = await app.request("/api/conversations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Bracket", cadEnvironment: "build123d" }),
    });
    const { id } = (await conversation.json()) as { id: string };

    for (const pySource of ["result = Box(10, 20, 30)", "result = Box(20, 20, 30)"]) {
      const response = await app.request(`/api/conversations/${id}/artifacts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pySource, paramsJson: null }),
      });
      expect(response.status).toBe(200);
    }

    const response = await app.request(`/api/conversations/${id}/artifacts`);
    expect(response.status).toBe(200);
    const artifacts = (await response.json()) as Array<{ version: number; pySource: string }>;
    expect(artifacts.map(({ version, pySource }) => ({ version, pySource }))).toEqual([
      { version: 1, pySource: "result = Box(10, 20, 30)" },
      { version: 2, pySource: "result = Box(20, 20, 30)" },
    ]);
  });

  it("rejects a missing or non-string pySource with 400", async () => {
    const app = createApp(openDb(":memory:"));
    const conversation = await app.request("/api/conversations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Bracket", cadEnvironment: "build123d" }),
    });
    const { id } = (await conversation.json()) as { id: string };

    for (const body of [{}, { pySource: 42 }, { pySource: null, paramsJson: null }]) {
      const response = await app.request(`/api/conversations/${id}/artifacts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "pySource required" });
    }
  });
});
