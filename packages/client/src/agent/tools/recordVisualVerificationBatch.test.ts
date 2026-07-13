import { expect, it, vi } from "vitest";
import { createRecordVisualVerificationBatchTool } from "./recordVisualVerificationBatch";

it("passes the visual batch tool call ID as the idempotency key", async () => {
  const input = {
    artifactId: "artifact-1", artifactVersion: 1, inspectionSheetId: "sheet-1", imageLimit: 3,
    activeReferenceIds: ["ref-1"], batchIndex: 0, batchCount: 1, coveredReferenceIds: ["ref-1"],
    observations: [{ referenceId: "ref-1", relevantViews: ["front"], findings: ["Matches."], affectedComponents: [] }],
    finalVerdict: "match" as const, synthesis: "Matches.",
  };
  const batch = { ...input, id: "batch-call", conversationId: "conv-1", recordedAt: 1 };
  const record = vi.fn(async () => batch);
  const tool = createRecordVisualVerificationBatchTool({ persistPending: async () => {}, record, onAccepted: vi.fn() });

  await tool.execute("batch-call", input);

  expect(record).toHaveBeenCalledWith(input, "batch-call");
});
