import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { ClassifyReferenceInput, ReferenceClassificationDto } from "@chamfer/shared";

const parameters = Type.Object({
  referenceId: Type.String({ description: "Stable reference ID shown beside the uploaded image." }),
  status: Type.Union([
    Type.Literal("active"),
    Type.Literal("complementary"),
    Type.Literal("superseded"),
  ]),
  purpose: Type.String({ description: "What design evidence this image provides." }),
  relationships: Type.Array(Type.Object({
    type: Type.Union([Type.Literal("complements"), Type.Literal("superseded-by")]),
    referenceId: Type.String(),
  })),
  rationale: Type.String({ description: "Why this semantic classification is correct." }),
  specificationIds: Type.Array(Type.String({
    description: "Active durable design-specification identities sourced from this conversation.",
  })),
  noSpecificationReason: Type.Optional(Type.String({
    description: "Required instead of specificationIds when the image yields no extractable specification.",
  })),
});

export function createClassifyReferenceTool(deps: {
  persistPending: () => Promise<void>;
  classify: (input: ClassifyReferenceInput, idempotencyKey?: string) => Promise<ReferenceClassificationDto>;
  onAccepted: (classification: ReferenceClassificationDto) => void;
}): AgentTool<typeof parameters, ReferenceClassificationDto> {
  return {
    name: "classify_reference",
    label: "Classify reference",
    description:
      "Record an append-only semantic classification for one uploaded reference image. Link active identities created by record_reference_specifications, or explain why none can be extracted. Classify every pending reference before run_build123d.",
    parameters,
    executionMode: "sequential",
    execute: async (toolCallId, input) => {
      await deps.persistPending();
      const classification = await deps.classify(input, toolCallId);
      deps.onAccepted(classification);
      return {
        content: [{
          type: "text",
          text: `Reference ${classification.referenceId} classified as ${classification.status}. Pixels may now leave routine context; the durable reference record remains.`,
        }],
        details: classification,
      };
    },
  };
}
