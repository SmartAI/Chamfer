import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { RecordSourceSpecificationsInput, SourceSpecificationDto } from "@chamfer/shared";

const parameters = Type.Object({
  specifications: Type.Array(Type.Object({
    id: Type.String({
      description: "New stable lowercase requirement identity. Use a new identity for corrected evidence.",
    }),
    requirement: Type.String({
      description: "What the design must honor, without a plan check or implementation choice.",
    }),
    attachmentId: Type.String({
      description: "Exact stable reference attachment ID that contains the evidence.",
    }),
    observation: Type.String({
      description: "The dimension, note, or visible fact read from the reference.",
    }),
    region: Type.Optional(Type.Object({
      x: Type.Number({ description: "Normalized left coordinate from 0 to 1." }),
      y: Type.Number({ description: "Normalized top coordinate from 0 to 1." }),
      width: Type.Number({ description: "Normalized region width greater than 0." }),
      height: Type.Number({ description: "Normalized region height greater than 0." }),
    })),
    supersedesSpecificationId: Type.Optional(Type.String({
      description: "Active specification identity replaced by this corrected source evidence.",
    })),
  }), { minItems: 1 }),
});

export function createRecordReferenceSpecificationsTool(deps: {
  persistPending: () => Promise<void>;
  record: (input: RecordSourceSpecificationsInput, idempotencyKey: string) => Promise<SourceSpecificationDto[]>;
  onAccepted: (specifications: SourceSpecificationDto[]) => void;
}): AgentTool<typeof parameters, { specifications: SourceSpecificationDto[] }> {
  return {
    name: "record_reference_specifications",
    label: "Record reference specifications",
    description:
      "Record immutable design requirements extracted from reference images, with exact attachment evidence and an optional normalized source region. Do this before classify_reference. Correct evidence with a new identity and supersedesSpecificationId.",
    parameters,
    executionMode: "sequential",
    execute: async (toolCallId, args) => {
      await deps.persistPending();
      const accepted = await deps.record({
        specifications: args.specifications.map((specification) => ({
          id: specification.id,
          requirement: specification.requirement,
          source: {
            attachmentId: specification.attachmentId,
            observation: specification.observation,
            ...(specification.region ? { region: specification.region } : {}),
          },
          ...(specification.supersedesSpecificationId
            ? { supersedesSpecificationId: specification.supersedesSpecificationId }
            : {}),
        })),
      }, toolCallId);
      deps.onAccepted(accepted);
      return {
        content: [{
          type: "text",
          text: `Recorded ${accepted.length} immutable reference specification${accepted.length === 1 ? "" : "s"}: ${accepted.map((specification) => specification.id).join(", ")}.`,
        }],
        details: { specifications: accepted },
      };
    },
  };
}
