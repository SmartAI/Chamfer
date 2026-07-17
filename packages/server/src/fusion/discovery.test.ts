import { describe, expect, it } from "vitest";
import { discoverFusionMcpEndpoint } from "./discovery";

describe("discoverFusionMcpEndpoint", () => {
  it("returns the preferred endpoint when it answers as the adapter", async () => {
    const probed: number[] = [];
    const found = await discoverFusionMcpEndpoint({
      preferredEndpoint: "http://127.0.0.1:41000/mcp",
      probe: async (port) => { probed.push(port); return port === 41000; },
      listPorts: async () => [],
    });
    expect(found).toBe("http://127.0.0.1:41000/mcp");
    expect(probed).toEqual([41000]);
  });

  it("falls back to Fusion's default port before scanning process ports", async () => {
    const probed: number[] = [];
    const found = await discoverFusionMcpEndpoint({
      preferredEndpoint: "http://127.0.0.1:41000/mcp",
      probe: async (port) => { probed.push(port); return port === 27182; },
      listPorts: async () => [59000],
      defaultPort: 27182,
    });
    expect(found).toBe("http://127.0.0.1:27182/mcp");
    expect(probed).toEqual([41000, 27182]);
  });

  it("discovers a drifted ephemeral port from the process's listeners", async () => {
    const probed: number[] = [];
    const found = await discoverFusionMcpEndpoint({
      preferredEndpoint: "http://127.0.0.1:27182/mcp",
      probe: async (port) => { probed.push(port); return port === 59921; },
      listPorts: async () => [59921, 59922],
      defaultPort: 27182,
    });
    expect(found).toBe("http://127.0.0.1:59921/mcp");
    // The prioritized preferred/default probe runs first; the lsof-derived
    // candidates are then probed concurrently, so all of them are attempted.
    expect(probed).toEqual([27182, 59921, 59922]);
  });

  it("prefers the earliest listed port when several answer concurrently", async () => {
    const found = await discoverFusionMcpEndpoint({
      probe: async (port) => port !== 27182,
      listPorts: async () => [59930, 59931],
      defaultPort: 27182,
    });
    expect(found).toBe("http://127.0.0.1:59930/mcp");
  });

  it("does not re-probe a port that appears in more than one candidate source", async () => {
    const probed: number[] = [];
    await discoverFusionMcpEndpoint({
      preferredEndpoint: "http://127.0.0.1:27182/mcp",
      probe: async (port) => { probed.push(port); return false; },
      listPorts: async () => [27182, 59921],
      defaultPort: 27182,
    });
    expect(probed).toEqual([27182, 59921]);
  });

  it("returns undefined when nothing answers as the adapter", async () => {
    const found = await discoverFusionMcpEndpoint({
      preferredEndpoint: "http://127.0.0.1:27182/mcp",
      probe: async () => false,
      listPorts: async () => [59921],
    });
    expect(found).toBeUndefined();
  });
});
