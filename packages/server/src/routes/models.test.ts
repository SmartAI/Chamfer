import { describe, expect, it } from "vitest";
import { openDb } from "../db";
import { createApp } from "../app";

function makeApp() {
  return createApp(openDb(":memory:"));
}

describe("models route", () => {
  it("lists only the three BYOK providers", async () => {
    const app = makeApp();
    const res = await app.request("/api/models");
    const list = (await res.json()) as Array<{ provider: string }>;
    expect(list.length).toBeGreaterThan(0);
    expect(new Set(list.map((m) => m.provider))).toEqual(new Set(["anthropic", "openai", "google"]));
  });
});
