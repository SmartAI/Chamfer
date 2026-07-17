import { describe, expect, it } from "vitest";
import { createLoopbackOnlyFetch, validateFusionMcpEndpoint } from "./mcpClient";

describe("validateFusionMcpEndpoint", () => {
  it("accepts only an explicit IPv4 loopback MCP endpoint", () => {
    expect(validateFusionMcpEndpoint("http://127.0.0.1:27182/mcp").href).toBe(
      "http://127.0.0.1:27182/mcp",
    );
  });

  it.each([
    "https://127.0.0.1:27182/mcp",
    "http://localhost:27182/mcp",
    "http://127.0.0.2:27182/mcp",
    "http://127.0.0.1/mcp",
    "http://127.0.0.1:27182/",
    "http://user@127.0.0.1:27182/mcp",
    "http://user:secret@127.0.0.1:27182/mcp",
    "http://[::1]:27182/mcp",
    "http://127.0.0.1:27182/mcp?token=x",
    "http://127.0.0.1:27182/mcp#fragment",
    "ftp://127.0.0.1:27182/mcp",
    "http://127.0.0.1:27182/mcp/../mcp",
    "http://127.0.0.1:27182/%6dcp",
  ])("rejects %s", (endpoint) => {
    expect(() => validateFusionMcpEndpoint(endpoint)).toThrow(
      "Fusion MCP endpoint must be exactly http://127.0.0.1:<port>/mcp",
    );
  });
});

describe("createLoopbackOnlyFetch", () => {
  it("does not forward a request to any URL other than the configured endpoint", async () => {
    const fetch = createLoopbackOnlyFetch(
      new URL("http://127.0.0.1:27182/mcp"),
      async () => new Response(null, { status: 204 }),
    );
    await expect(fetch("http://127.0.0.1:27183/mcp")).rejects.toThrow("refused a non-configured URL");
  });

  it("fails closed when the endpoint redirects outside loopback", async () => {
    const fetch = createLoopbackOnlyFetch(
      new URL("http://127.0.0.1:27182/mcp"),
      async (_url, init) => {
        expect(init?.redirect).toBe("manual");
        return new Response(null, { status: 302, headers: { location: "https://example.com/mcp" } });
      },
    );
    await expect(fetch("http://127.0.0.1:27182/mcp")).rejects.toThrow("refused an unsafe redirect");
  });

  it("refuses arbitrary request headers instead of forwarding credentials through the bridge", async () => {
    const transport = createLoopbackOnlyFetch(
      new URL("http://127.0.0.1:27182/mcp"),
      async () => new Response(null, { status: 204 }),
    );
    await expect(transport("http://127.0.0.1:27182/mcp", {
      method: "POST",
      headers: { authorization: "Bearer secret" },
    })).rejects.toThrow("refused request header authorization");
  });
});
