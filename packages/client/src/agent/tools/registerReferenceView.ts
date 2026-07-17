import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type {
  CreateReferenceRegistrationInput,
  ReferenceRegistrationDto,
  ReferenceRegistrationProposal,
} from "@chamfer/shared";
import { extractReferenceGeometry } from "../referenceGeometry";

const point = Type.Object({
  x: Type.Number({ description: "Normalized horizontal attachment coordinate from 0 to 1." }),
  y: Type.Number({ description: "Normalized vertical attachment coordinate from 0 to 1." }),
});

const parameters = Type.Object({
  referenceId: Type.String({ description: "Active reference attachment identity." }),
  sourceRegion: Type.Object({
    x: Type.Number({ description: "Normalized left coordinate from 0 to 1." }),
    y: Type.Number({ description: "Normalized top coordinate from 0 to 1." }),
    width: Type.Number({ description: "Normalized region width greater than 0." }),
    height: Type.Number({ description: "Normalized region height greater than 0." }),
  }),
  projection: Type.Union([
    Type.Literal("orthographic"),
    Type.Literal("perspective"),
    Type.Literal("unknown"),
  ], { description: "Projection established from source evidence, never from the CAD result." }),
  direction: Type.Optional(Type.Union([
    Type.Literal("front"),
    Type.Literal("back"),
    Type.Literal("left"),
    Type.Literal("right"),
    Type.Literal("top"),
    Type.Literal("bottom"),
  ])),
  scaleAnchor: Type.Optional(Type.Object({
    specificationId: Type.String({ description: "Active reference-source specification containing this dimension." }),
    start: point,
    end: point,
    physicalLengthMm: Type.Number({ description: "Dimension value selected from the linked specification." }),
  })),
  visibleLandmarks: Type.Array(Type.Object({
    id: Type.String({ description: "Stable semantic landmark identity." }),
    label: Type.String({ description: "Human-readable visible feature." }),
    position: point,
  })),
  uncertainty: Type.Object({
    level: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
    notes: Type.String({ description: "Source-based uncertainty, ambiguity, or exclusion notes." }),
    occluded: Type.Boolean({ description: "Whether the proof-bearing object outline is materially occluded." }),
  }),
});

export function createRegisterReferenceViewTool(deps: {
  persistPending: () => Promise<void>;
  download: (attachmentId: string, expectedMimeType: string) => ReturnType<typeof import("../../api/rest").downloadAttachment>;
  register: (input: CreateReferenceRegistrationInput, idempotencyKey: string) => Promise<ReferenceRegistrationDto>;
  onAccepted: (registration: ReferenceRegistrationDto) => void;
}): AgentTool<typeof parameters, ReferenceRegistrationDto> {
  return {
    name: "register_reference_view",
    label: "Register reference view",
    description:
      "Register an active reference for independent shape evidence before the first non-probe CAD run. Propose only semantic source fields: region, projection, canonical direction, a source-specification scale anchor, visible landmarks, and uncertainty. Chamfer derives the mask, contour, pixel scale, and eligibility from the original source pixels. Perspective, unscaled, occluded, uncertain, or extraction-failed views remain advisory with explicit reasons.",
    parameters,
    executionMode: "sequential",
    execute: async (toolCallId, args) => {
      await deps.persistPending();
      const proposal = args as ReferenceRegistrationProposal;
      const image = await deps.download(proposal.referenceId, "image/png");
      const geometry = await extractReferenceGeometry(image, proposal);
      const registration = await deps.register({ ...proposal, geometry }, toolCallId);
      deps.onAccepted(registration);
      const scale = registration.geometry.scaleTransform;
      return {
        content: [{
          type: "text",
          text: registration.eligibility.status === "eligible"
            ? `Reference ${registration.referenceId} registered as eligible ${registration.direction} orthographic evidence at ${scale?.mmPerPixel.toFixed(4)} mm/px.`
            : `Reference ${registration.referenceId} registered as advisory evidence: ${registration.eligibility.reasons.join(" ")}`,
        }],
        details: registration,
      };
    },
  };
}
