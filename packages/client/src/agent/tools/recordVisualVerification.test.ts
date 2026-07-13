import { describe, expect, it, vi } from "vitest";
import { createRecordVisualVerificationTool } from "./recordVisualVerification";

describe("record_visual_verification", () => {
  it("waits for current artifact persistence, records, and publishes the verdict", async () => {
    const order: string[] = [];
    const input = {
      artifactId: "artifact-2", artifactVersion: 2, inspectionSheetId: "sheet-2",
      coveredReferenceIds: ["ref-a"], verdict: "match" as const,
      observations: [{ referenceId: "ref-a", relevantViews: ["front"], findings: ["Matches."], affectedComponents: [] }],
    };
    const record = { ...input, id: "verification-1", conversationId: "conversation-a", recordedAt: 1 };
    const onAccepted = vi.fn();
    const persistRecord = vi.fn(async () => { order.push("record"); return record; });
    const tool = createRecordVisualVerificationTool({
      persistPending: async () => { order.push("persist"); },
      record: persistRecord,
      onAccepted,
    });

    const result = await tool.execute("call-1", input);

    expect(order).toEqual(["persist", "record"]);
    expect(persistRecord).toHaveBeenCalledWith(input, "call-1");
    expect(onAccepted).toHaveBeenCalledWith(record);
    expect(result.details).toEqual(record);
    expect(JSON.stringify(result.content)).toContain("match");
  });
});
