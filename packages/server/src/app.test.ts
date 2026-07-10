import { describe, expect, it } from "vitest";
import { openDb } from "./db";
import { createApp } from "./app";

describe("app", () => {
  it("answers health", async () => {
    const app = createApp(openDb(":memory:"));
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
