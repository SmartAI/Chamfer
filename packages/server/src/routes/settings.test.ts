import { describe, expect, it } from "vitest";
import { openDb } from "../db";
import { createApp } from "../app";

function makeApp() {
  return createApp(openDb(":memory:"));
}

describe("settings routes", () => {
  it("round-trips keys and masks them on read", async () => {
    const app = makeApp();
    const put = await app.request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        anthropicApiKey: "sk-ant-12345678",
        anthropicBaseUrl: "https://gateway.example/anthropic",
      }),
    });
    expect(put.status).toBe(200);
    const got = (await (await app.request("/api/settings")).json()) as {
      anthropicApiKey: string;
      anthropicBaseUrl: string;
    };
    expect(got.anthropicApiKey).toBe("***5678");
    expect(got.anthropicBaseUrl).toBe("https://gateway.example/anthropic");
  });

  it("ignores masked values on write", async () => {
    const app = makeApp();
    await app.request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ anthropicApiKey: "sk-ant-12345678" }),
    });
    await app.request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ anthropicApiKey: "***5678", openaiApiKey: "sk-oai-abcd" }),
    });
    const got = (await (await app.request("/api/settings")).json()) as Record<string, string>;
    expect(got.anthropicApiKey).toBe("***5678"); // unchanged, not overwritten with the mask
    expect(got.openaiApiKey).toBe("***abcd");
  });
});
