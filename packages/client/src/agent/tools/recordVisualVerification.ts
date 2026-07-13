import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { RecordVisualVerificationInput, VisualVerificationRecordDto } from "@chamfer/shared";

const parameters = Type.Object({
  artifactId: Type.String({ description: "Exact current deliverable artifact ID." }),
  artifactVersion: Type.Integer({ minimum: 1, description: "Exact current artifact version." }),
  inspectionSheetId: Type.String({ description: "Exact current inspection-sheet attachment ID." }),
  coveredReferenceIds: Type.Array(Type.String(), { description: "Every active reference ID covered by this verdict." }),
  verdict: Type.Union([Type.Literal("match"), Type.Literal("needs-revision")]),
  observations: Type.Array(Type.Object({
    referenceId: Type.String(),
    relevantViews: Type.Array(Type.String()),
    findings: Type.Array(Type.String()),
    affectedComponents: Type.Array(Type.String()),
  })),
});

export interface RecordVisualVerificationDeps {
  persistPending: () => Promise<unknown>;
  record: (input: RecordVisualVerificationInput, idempotencyKey?: string) => Promise<VisualVerificationRecordDto>;
  onAccepted: (record: VisualVerificationRecordDto) => void;
}

export function createRecordVisualVerificationTool(deps: RecordVisualVerificationDeps): AgentTool<typeof parameters, VisualVerificationRecordDto> {
  return {
    name: "record_visual_verification",
    label: "Record visual verification",
    description: "Record the final structured visual comparison of every active reference against the exact current gate-passed CAD artifact and inspection sheet. A needs-revision verdict is durable but blocks finalization until a new current match is recorded.",
    parameters,
    execute: async (toolCallId, input) => {
      await deps.persistPending();
      const record = await deps.record(input, toolCallId);
      deps.onAccepted(record);
      return {
        content: [{ type: "text", text: `Visual verification recorded: ${record.verdict}; artifact ${record.artifactId} version ${record.artifactVersion}; sheet ${record.inspectionSheetId}; references ${record.coveredReferenceIds.join(", ")}.` }],
        details: record,
      };
    },
  };
}
