import { describe, expect, it, vi } from "vitest";
import type { FusionInspectionDto } from "@chamfer/shared";
import { createInspectFusionTool, latestFusionInspectionIdentity } from "./inspectFusion";

describe("inspect_fusion model evidence", () => {
  it("returns the necessary bound snapshot without native tokens, endpoint data, or raw traffic", async () => {
    const result = {
      document: { id: "doc-1", name: "Bracket", dataFileId: "data-1" },
      readiness: { endpoint: "http://127.0.0.1:27182/mcp" },
      current: {
        id: "inspection-1", revision: "rev-1",
        snapshot: {
          designIntent: { designType: "parametric", rootComponent: "Bracket", timelineMarker: 2 },
          units: { distance: "mm", angle: "deg", internalDistance: "cm" },
          parameters: [{ id: "width", name: "width", expression: "80 mm", valueMm: 80, unit: "mm" }],
          sketches: [], features: [], bodies: [], materials: [],
          entities: [{ kind: "body", id: "body-1", name: "Body", nativeToken: "private-native-token" }],
        },
        checks: [], screenshots: [], cameraRestored: true,
      },
    } as unknown as FusionInspectionDto;
    const tool = createInspectFusionTool({ inspect: vi.fn().mockResolvedValue(result) });
    const output = await tool.execute("call-1", { checks: [] });
    const content = JSON.stringify(output.content);
    expect(content).toContain("80 mm");
    expect(content).toContain("body-1");
    expect(content).not.toContain("private-native-token");
    expect(content).not.toContain("127.0.0.1");
    expect(content).not.toContain("data:image");
    // A scalar inspection (no rendered views) stays text-only and pixel-free.
    expect(output.content.every((block) => (block as { type?: string }).type === "text")).toBe(true);
    expect(output.details).toMatchObject({ mutated: false, revision: "rev-1", viewSheet: false });
  });
});

describe("latestFusionInspectionIdentity", () => {
  const inspectResult = (id: string, revision: string) => ({
    role: "toolResult", toolName: "inspect_fusion", isError: false,
    details: { mutated: false, inspectionId: id, revision, viewSheet: false },
  });
  const actionResult = (id: string, revision: string, status = "completed") => ({
    role: "toolResult", toolName: "run_fusion_action", isError: false,
    details: { mutated: status !== "rolled-back", status, finalRevision: revision,
      inspection: { current: { id, revision } } },
  });

  it("uses the post-action trusted inspection so no re-inspect is needed between actions", () => {
    const messages = [inspectResult("insp-1", "rev-1"), actionResult("insp-2", "rev-2")];
    expect(latestFusionInspectionIdentity(messages)).toEqual({ inspectionId: "insp-2", revision: "rev-2" });
  });

  it("uses the restored inspection from a rolled-back action", () => {
    const messages = [inspectResult("insp-1", "rev-1"), actionResult("insp-3", "rev-1", "rolled-back")];
    expect(latestFusionInspectionIdentity(messages)).toEqual({ inspectionId: "insp-3", revision: "rev-1" });
  });

  it("still prefers a newer explicit inspection and skips errored results", () => {
    const messages = [
      actionResult("insp-2", "rev-2"),
      { role: "toolResult", toolName: "run_fusion_action", isError: true, details: {} },
      inspectResult("insp-4", "rev-2"),
    ];
    expect(latestFusionInspectionIdentity(messages)).toEqual({ inspectionId: "insp-4", revision: "rev-2" });
  });
});
