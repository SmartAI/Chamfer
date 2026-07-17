import { describe, expect, it, vi } from "vitest";
import type { FusionDocumentationResultDto, FusionReadinessDto } from "@chamfer/shared";
import { openDb } from "../db";
import { createApp } from "../app";

describe("Fusion readiness route", () => {
  it("returns only the normalized server-owned readiness contract", async () => {
    const readiness: FusionReadinessDto = {
      state: "ready",
      label: "Ready",
      diagnosis: "Fusion is connected and compatible.",
      endpoint: "http://127.0.0.1:27182/mcp",
      checkedAt: "2026-07-14T12:00:00.000Z",
      document: { id: "doc-1", name: "Bracket" },
      mutationAllowed: false,
    };
    const current = vi.fn().mockResolvedValue(readiness);
    const app = createApp(openDb(":memory:"), undefined, { fusionReadiness: { current } });

    const response = await app.request("/api/fusion/readiness");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(readiness);
    expect(current).toHaveBeenCalledOnce();
  });

  it("returns concise installed API excerpts through the Chamfer-owned documentation route", async () => {
    const result: FusionDocumentationResultDto = {
      query: "setDistanceExtent",
      excerpts: ["adsk.fusion.ExtrudeFeatureInput.setDistanceExtent(distance: ValueInput)"],
      source: {
        kind: "installed-fusion-api",
        fusionVersion: "2704.1.23",
        mcpProtocolVersion: "2025-11-25",
        mcpServer: "MCP Server Adapter 1.0.0",
      },
    };
    const search = vi.fn().mockResolvedValue(result);
    const app = createApp(openDb(":memory:"), undefined, { fusionDocumentation: { search } });

    const response = await app.request("/api/fusion/documentation", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: "setDistanceExtent",
        category: "member",
        namespace: "adsk.fusion",
        owner: "adsk.fusion.ExtrudeFeatureInput",
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(result);
    expect(search).toHaveBeenCalledWith({
      query: "setDistanceExtent",
      category: "member",
      namespace: "adsk.fusion",
      owner: "adsk.fusion.ExtrudeFeatureInput",
    });
  });

  it("rejects requests that could turn the documentation route into a raw MCP passthrough", async () => {
    const search = vi.fn();
    const app = createApp(openDb(":memory:"), undefined, { fusionDocumentation: { search } });

    const response = await app.request("/api/fusion/documentation", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "Camera", category: "screenshot", namespace: "projects" }),
    });

    expect(response.status).toBe(400);
    expect(search).not.toHaveBeenCalled();
  });

  it("does not forward raw connector failures through the documentation route", async () => {
    const search = vi.fn().mockRejectedValue(new Error("Bearer connector-secret unrelated-project.f3d"));
    const app = createApp(openDb(":memory:"), undefined, { fusionDocumentation: { search } });
    const response = await app.request("/api/fusion/documentation", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "Design", category: "class", namespace: "adsk.fusion" }),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Installed Fusion API lookup failed." });
  });
});
