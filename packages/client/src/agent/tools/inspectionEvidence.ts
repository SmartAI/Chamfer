import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type ImageContent } from "@earendil-works/pi-ai";
import type {
  InspectEvidenceInput,
  InspectionLeaseDto,
  InspectionObservationInput,
} from "@chamfer/shared";

const inspectParameters = Type.Object({
  evidenceIds: Type.Array(Type.String({ description: "Stable reference or inspection-sheet attachment ID." }), {
    minItems: 1,
  }),
  purpose: Type.String({ description: "Specific visual question this inspection will answer." }),
});

const observationParameters = Type.Object({
  leaseId: Type.String({ description: "Open inspection lease being completed." }),
  relevantViews: Type.Array(Type.String({ description: "View inspected, such as front, top, or isometric." }), { minItems: 1 }),
  facts: Type.Array(Type.String({ description: "Concrete visual fact established from the selected evidence." }), { minItems: 1 }),
  affectedSpecifications: Type.Array(Type.String({ description: "Stable specification identifiers affected by these facts." })),
  affectedComponents: Type.Array(Type.String({ description: "Stable component identifiers affected by these facts." })),
  noAffectedEntityReason: Type.Optional(Type.String({
    description: "Required when no specification or component is affected.",
  })),
});

export function createInspectEvidenceTool(deps: {
  persistPending: () => Promise<void>;
  openLease: (input: InspectEvidenceInput, idempotencyKey?: string) => Promise<InspectionLeaseDto>;
  download: (id: string, mime: string) => Promise<ImageContent>;
  onOpened: (lease: InspectionLeaseDto) => void;
}): AgentTool<typeof inspectParameters, InspectionLeaseDto> {
  return {
    name: "inspect_evidence",
    label: "Inspect evidence",
    description: "Retrieve selected stored reference images or historical inspection sheets for a stated visual purpose. The pixels remain leased until structured observations are recorded.",
    parameters: inspectParameters,
    executionMode: "sequential",
    execute: async (toolCallId, input) => {
      await deps.persistPending();
      const lease = await deps.openLease(input, toolCallId);
      deps.onOpened(lease);
      const images = await Promise.all(lease.evidence.map((item) => deps.download(item.attachmentId, item.mime)));
      return {
        content: [
          { type: "text", text: `Inspection lease ${lease.id} opened for ${lease.evidence.map((item) => item.attachmentId).join(", ")}.` },
          ...images,
        ],
        details: lease,
      };
    },
  };
}

export function createRecordInspectionObservationTool(deps: {
  persistPending: () => Promise<void>;
  record: (leaseId: string, input: InspectionObservationInput, idempotencyKey?: string) => Promise<InspectionLeaseDto>;
  onClosed: (lease: InspectionLeaseDto) => void;
}): AgentTool<typeof observationParameters, InspectionLeaseDto> {
  return {
    name: "record_inspection_observation",
    label: "Record inspection observation",
    description: "Durably record views, facts, and affected specifications or components for an open inspection lease. Successful recording closes the lease and evicts its pixels.",
    parameters: observationParameters,
    executionMode: "sequential",
    execute: async (toolCallId, { leaseId, ...input }) => {
      await deps.persistPending();
      const lease = await deps.record(leaseId, input, toolCallId);
      deps.onClosed(lease);
      return {
        content: [{ type: "text", text: `Inspection observation recorded for lease ${lease.id}. Its pixels are now evicted from model context.` }],
        details: lease,
      };
    },
  };
}
