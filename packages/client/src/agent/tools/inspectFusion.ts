import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { FusionCheckInput, FusionInspectionDto } from "@chamfer/shared";
import { composeFusionViewSheet } from "../fusionViewSheet";
import { FUSION_INSPECTION_CHECKS_PREFIX, FUSION_INSPECTION_HEADER } from "../inspectionSheetLifecycle";

const parameters = Type.Object({
  checks: Type.Optional(Type.Array(Type.Object({ kind: Type.String() }, { additionalProperties: true }))),
});

/** One requested check paired with the trusted inspector's aligned verdict.
 * This is the durable, structured record Fusion completion evidence is built
 * from (the text rendering is for the model, not for bookkeeping). */
export interface FusionEvaluatedCheck {
  input: FusionCheckInput;
  status: "passed" | "failed" | "unsupported";
}

export interface InspectFusionDetails {
  mutated: false;
  revision: string;
  inspectionId: string;
  viewSheet: boolean;
  evaluatedChecks: FusionEvaluatedCheck[];
  bodyVolumesMm3: number[];
  /** Present for rendered visual reads: the revision-bound visual artifact this
   * sheet belongs to, making a read-only inspection sufficient current evidence
   * for visual finalization (attachmentId is linked at persistence time). */
  visualArtifact?: { artifactId: string; artifactVersion: number; revision: string; inspectionSheet: { attachmentId?: string } };
}

export function createInspectFusionTool(deps: {
  inspect: (checks: FusionCheckInput[]) => Promise<FusionInspectionDto>;
}): AgentTool<typeof parameters, InspectFusionDetails> {
  return {
    name: "inspect_fusion",
    label: "Inspect bound Fusion design",
    description: "Read the bound Fusion document's authoritative engineering revision, high-level entities, and typed effects before constructing an action. This capability is read-only.",
    parameters,
    execute: async (_toolCallId, input) => {
      const result = await deps.inspect((input.checks ?? []) as FusionCheckInput[]);
      const current = result.current;
      const snapshot = {
        ...current.snapshot,
        entities: current.snapshot.entities.map((entity) => ({
          kind: entity.kind,
          id: entity.id,
          name: entity.name,
          ...(entity.chamferId ? { chamferId: entity.chamferId } : {}),
        })),
      };
      // When the inspector rendered views (a visual-evidence check was requested),
      // hand the model the composed view sheet so it can read the layout - the top
      // view reveals feature interference that no scalar check can see. Text-only
      // inspections (no views requested) stay pixel-free so routine scalar reads
      // neither sweep the camera nor spend image budget.
      const sheet = await composeFusionViewSheet(current.screenshots);
      const text = [
        FUSION_INSPECTION_HEADER,
        `Document: ${result.document.name} (${result.document.dataFileId ?? result.document.id})`,
        `Revision: ${current.revision}`,
        `Snapshot: ${JSON.stringify(snapshot)}`,
        `${FUSION_INSPECTION_CHECKS_PREFIX}${JSON.stringify(current.checks)}`,
        ...(sheet ? [`Rendered views (${sheet.views.join(", ")}) are attached. Read the top view for feature interference and crowding before continuing.`] : []),
      ].join("\n");
      // The server evaluates exactly the requested checks in order, so the
      // verdicts align 1:1 with the inputs.
      const requested = (input.checks ?? []) as FusionCheckInput[];
      const evaluatedChecks = requested.map((check, index) => ({
        input: check,
        status: current.checks[index]?.status ?? "unsupported" as const,
      }));
      return {
        content: [{ type: "text" as const, text }, ...(sheet ? [sheet.image] : [])],
        details: {
          mutated: false as const, revision: current.revision, inspectionId: current.id, viewSheet: Boolean(sheet),
          evaluatedChecks,
          bodyVolumesMm3: current.snapshot.bodies.map((body) => body.volumeMm3),
          ...(sheet && result.visualArtifact
            ? { visualArtifact: { ...result.visualArtifact, revision: current.revision, inspectionSheet: {} } }
            : {}),
        },
      };
    },
  };
}

/**
 * The newest trusted inspection identity in the transcript. Every
 * run_fusion_action result already carries the independent post-action
 * inspection Chamfer recorded (completed, nonconforming, and rolled-back
 * results alike), so it is exactly as authoritative as an explicit
 * inspect_fusion call - accepting it here removes the forced inspect_fusion
 * round-trip between every pair of actions.
 */
export function latestFusionInspectionIdentity(messages: readonly unknown[]): { inspectionId: string; revision: string } | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: unknown; toolName?: unknown; isError?: unknown; details?: unknown };
    if (message?.role !== "toolResult" || message.isError === true
      || typeof message.details !== "object" || message.details === null) continue;
    if (message.toolName === "inspect_fusion") {
      const details = message.details as { inspectionId?: unknown; revision?: unknown };
      if (typeof details.inspectionId === "string" && typeof details.revision === "string") {
        return { inspectionId: details.inspectionId, revision: details.revision };
      }
    }
    if (message.toolName === "run_fusion_action") {
      const details = message.details as { finalRevision?: unknown; inspection?: { current?: { id?: unknown; revision?: unknown } } };
      const current = details.inspection?.current;
      if (typeof current?.id === "string" && typeof current.revision === "string") {
        return { inspectionId: current.id, revision: current.revision };
      }
    }
  }
  return undefined;
}
