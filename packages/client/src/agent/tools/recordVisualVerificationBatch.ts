import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { RecordVisualVerificationBatchInput, VisualVerificationBatchRecordDto } from "@chamfer/shared";

const observation = Type.Object({
  referenceId: Type.String(),
  relevantViews: Type.Array(Type.String()),
  findings: Type.Array(Type.String()),
  affectedComponents: Type.Array(Type.String()),
});

const parameters = Type.Object({
  artifactId: Type.String(),
  artifactVersion: Type.Integer({ minimum: 1 }),
  inspectionSheetId: Type.String(),
  imageLimit: Type.Integer({ minimum: 2 }),
  activeReferenceIds: Type.Array(Type.String()),
  batchIndex: Type.Integer({ minimum: 0 }),
  batchCount: Type.Integer({ minimum: 1 }),
  coveredReferenceIds: Type.Array(Type.String()),
  observations: Type.Array(observation),
  finalVerdict: Type.Optional(Type.Union([Type.Literal("match"), Type.Literal("needs-revision")])),
  synthesis: Type.Optional(Type.String()),
});

export function createRecordVisualVerificationBatchTool(deps: {
  persistPending: () => Promise<unknown>;
  record: (input: RecordVisualVerificationBatchInput, idempotencyKey?: string) => Promise<VisualVerificationBatchRecordDto>;
  onAccepted: (record: VisualVerificationBatchRecordDto) => void;
}): AgentTool<typeof parameters, VisualVerificationBatchRecordDto> {
  return {
    name: "record_visual_verification_batch",
    label: "Record visual verification batch",
    description: "Record exactly the requested deterministic visual batch. Earlier observations are carried as text. Only the final batch includes the synthesized verdict and synthesis.",
    parameters,
    execute: async (toolCallId, input) => {
      await deps.persistPending();
      const record = await deps.record(input, toolCallId);
      deps.onAccepted(record);
      return {
        content: [{ type: "text", text: `Visual batch ${record.batchIndex + 1}/${record.batchCount} recorded for ${record.coveredReferenceIds.join(", ")}.${record.finalVerification ? ` Final verdict: ${record.finalVerification.verdict}.` : ""}` }],
        details: record,
      };
    },
  };
}
