import { describe, expect, it, vi } from "vitest";
import type { InspectionLeaseDto } from "@chamfer/shared";
import { createInspectEvidenceTool, createRecordInspectionObservationTool } from "./inspectionEvidence";

const lease: InspectionLeaseDto = {
  id: "lease-1",
  conversationId: "conv-1",
  purpose: "Inspect profile",
  status: "open",
  evidence: [{ attachmentId: "ref-1", kind: "user-image", mime: "image/png" }],
  openedAt: 1,
};

describe("inspection evidence tools", () => {
  it("returns native pi images only after the durable lease opens", async () => {
    const order: string[] = [];
    const openLease = vi.fn(async () => { order.push("lease"); return lease; });
    const tool = createInspectEvidenceTool({
      persistPending: async () => { order.push("persist"); },
      openLease,
      download: async () => { order.push("download"); return { type: "image", data: "pixels", mimeType: "image/png" }; },
      onOpened: vi.fn(),
    });
    const result = await tool.execute("call-1", { evidenceIds: ["ref-1"], purpose: "Inspect profile" });
    expect(order).toEqual(["persist", "lease", "download"]);
    expect(openLease).toHaveBeenCalledWith({ evidenceIds: ["ref-1"], purpose: "Inspect profile" }, "call-1");
    expect(result.content).toContainEqual({ type: "image", data: "pixels", mimeType: "image/png" });
  });

  it("does not evict an open lease when observation persistence rejects", async () => {
    const onClosed = vi.fn();
    const tool = createRecordInspectionObservationTool({
      persistPending: async () => {},
      record: vi.fn().mockRejectedValue(new Error("observation store unavailable")),
      onClosed,
    });
    await expect(tool.execute("call-2", {
      leaseId: "lease-1",
      relevantViews: ["front"],
      facts: ["fact"],
      affectedSpecifications: ["spec.a"],
      affectedComponents: [],
    })).rejects.toThrow("observation store unavailable");
    expect(onClosed).not.toHaveBeenCalled();
  });

  it("passes the observation tool call ID as the idempotency key", async () => {
    const record = vi.fn(async () => ({ ...lease, status: "closed" as const, closedAt: 2 }));
    const tool = createRecordInspectionObservationTool({ persistPending: async () => {}, record, onClosed: vi.fn() });
    const input = { leaseId: "lease-1", relevantViews: ["front"], facts: ["fact"], affectedSpecifications: ["spec.a"], affectedComponents: [] };
    await tool.execute("observation-call", input);
    expect(record).toHaveBeenCalledWith("lease-1", {
      relevantViews: ["front"], facts: ["fact"], affectedSpecifications: ["spec.a"], affectedComponents: [],
    }, "observation-call");
  });
});
