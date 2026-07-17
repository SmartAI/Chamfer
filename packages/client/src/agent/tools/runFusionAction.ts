import type { AgentTool } from "@earendil-works/pi-agent-core";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type {
  FusionActionRequestDto, FusionActionResultDto, FusionModelIdentityDto, FusionSkillAttributionDto,
} from "@chamfer/shared";
import { FusionExpectedEffectSchema } from "@chamfer/shared";
import { composeFusionViewSheet, type FusionViewSheet } from "../fusionViewSheet";

const parameters = Type.Object({
  document: Type.Object({ id: Type.String(), name: Type.String(), dataFileId: Type.Optional(Type.String()) }),
  expectedRevision: Type.String({ description: "Exact revision from the latest trusted Fusion inspection." }),
  intent: Type.String({ description: "One coherent, reversible feature-level modeling intent." }),
  strategy: StringEnum(["targeted", "destructive-rebuild"], { description: "Use targeted unless the user explicitly requested or approved replacement." }),
  body: Type.String({ description: "Direct adsk.core/adsk.fusion API code executed inside Chamfer's supplied transaction capabilities. Do not define run(), acquire Application, or verify your own result." }),
  affectedReferences: Type.Array(Type.Object({ id: Type.String(), kind: StringEnum(["parameter", "sketch", "feature", "body", "component"]) })),
  expectedEffects: Type.Optional(Type.Array(FusionExpectedEffectSchema, {
    description: "Optional self-checks. Each is measured and reported back informationally; a mismatch never rolls the action back. Binding verification happens once, at the final plan completion inspection.",
  })),
});

export interface RunFusionActionDetails {
  mutated: boolean;
  status: FusionActionResultDto["status"];
  precedingRevision: string;
  finalRevision: string;
  undoEntries: number;
  ledgerRecordIds: string[];
  inspection: FusionActionResultDto["inspection"];
  visualArtifact?: { artifactId: string; artifactVersion: number; revision: string; inspectionSheet?: { attachmentId?: string } };
}

async function inspectionSheetImage(result: FusionActionResultDto): Promise<FusionViewSheet | undefined> {
  const screenshots = result.inspection?.current?.screenshots ?? [];
  if (result.status !== "completed" || !result.visualArtifact) return undefined;
  return composeFusionViewSheet(screenshots);
}

export interface FusionDestructiveAuthority {
  basis: "original-replacement-request" | "explicit-approval";
  evidenceMessageId: string;
  statement: string;
}

export interface FusionReconciliationAuthority {
  reconciliationId: string;
  evidenceMessageId: string;
  statement: string;
}

function canonicalReferences(references: FusionActionRequestDto["affectedReferences"]): string {
  return references.map((reference) => `${reference.kind}:${reference.id}`).sort().join(",") || "none";
}

const DESTRUCTIVE_NEGATION = /\b(?:do not|don't|without|avoid|preserve)\b[^.\n]{0,40}\b(?:rebuild|replace|discard|delete)\b/i;

export function destructiveAuthorityFromMessages(
  messages: readonly unknown[],
  persistenceId: (message: unknown) => string | undefined,
  expectedRevision?: string,
  intent?: string,
): FusionDestructiveAuthority | undefined {
  const message = [...messages].reverse().find((candidate) => (candidate as { role?: unknown }).role === "user");
  const candidate = message as { content?: unknown } | undefined;
  if (!message || !Array.isArray(candidate?.content)) return undefined;
  const statement = candidate.content
    .filter((block): block is { type: "text"; text: string } => (block as { type?: unknown })?.type === "text" && typeof (block as { text?: unknown }).text === "string")
    .map((block) => block.text).join("\n").trim();
  const evidenceMessageId = persistenceId(message);
  if (!evidenceMessageId || statement.includes("?") || DESTRUCTIVE_NEGATION.test(statement)) return undefined;
  const confirmation = /^CONFIRM FUSION REBUILD (\S+):\s*(.+)$/i.exec(statement);
  if (confirmation) {
    const [, revision, confirmedIntent] = confirmation;
    if (!expectedRevision || !intent || revision !== expectedRevision || confirmedIntent?.trim() !== intent.trim()) return undefined;
    return { basis: "explicit-approval", evidenceMessageId, statement };
  }
  return intent && statement === `REQUEST FUSION REBUILD: ${intent}`
    ? { basis: "original-replacement-request", evidenceMessageId, statement }
    : undefined;
}

export function reconciliationAuthorityFromMessages(
  messages: readonly unknown[],
  persistenceId: (message: unknown) => string | undefined,
  expectedRevision: string,
  intent: string,
  affectedReferences: FusionActionRequestDto["affectedReferences"],
): FusionReconciliationAuthority | undefined {
  const message = [...messages].reverse().find((candidate) => (candidate as { role?: unknown }).role === "user");
  const candidate = message as { content?: unknown } | undefined;
  if (!message || !Array.isArray(candidate?.content)) return undefined;
  const statement = candidate.content
    .filter((block): block is { type: "text"; text: string } => (block as { type?: unknown })?.type === "text" && typeof (block as { text?: unknown }).text === "string")
    .map((block) => block.text).join("\n").trim();
  const match = /^CONFIRM FUSION RECONCILIATION (\S+) AT (\S+) REFERENCES (\S+):\s*(.+)$/i.exec(statement);
  const evidenceMessageId = persistenceId(message);
  const reconciliationId = match?.[1];
  if (!reconciliationId || !evidenceMessageId || match?.[2] !== expectedRevision
    || match?.[3] !== canonicalReferences(affectedReferences) || match?.[4]?.trim() !== intent.trim()) return undefined;
  return { reconciliationId, evidenceMessageId, statement };
}

export function createRunFusionActionTool(deps: {
  execute: (request: FusionActionRequestDto, signal?: AbortSignal) => Promise<FusionActionResultDto>;
  model: FusionModelIdentityDto;
  skillAttribution: () => FusionSkillAttributionDto;
  inspectionIdentity: () => { inspectionId: string; revision: string } | undefined;
  destructiveAuthority: (expectedRevision: string, intent: string) => FusionDestructiveAuthority | undefined;
  reconciliationAuthority: (expectedRevision: string, intent: string, affectedReferences: FusionActionRequestDto["affectedReferences"]) => FusionReconciliationAuthority | undefined;
}): AgentTool<typeof parameters, RunFusionActionDetails> {
  return {
    name: "run_fusion_action",
    label: "Run atomic Fusion action",
    description: "Execute one policy-constrained direct Fusion API action against an exact bound document revision. Chamfer independently inspects effects, retains structurally valid mismatches for targeted repair, and automatically undoes structural failures.",
    parameters,
    execute: async (toolCallId, input, signal) => {
      const inspection = deps.inspectionIdentity();
      if (!inspection || inspection.revision !== input.expectedRevision) {
        throw new Error("run_fusion_action requires expectedRevision from the latest successful inspect_fusion result.");
      }
      const authority = input.strategy === "destructive-rebuild" ? deps.destructiveAuthority(input.expectedRevision, input.intent) : undefined;
      const destructiveApproval = authority ? { ...authority, expectedRevision: input.expectedRevision, intent: input.intent } : undefined;
      const affectedReferences = input.affectedReferences as FusionActionRequestDto["affectedReferences"];
      const reconciliationAuthority = deps.reconciliationAuthority(input.expectedRevision, input.intent, affectedReferences);
      const reconciliationResolution = reconciliationAuthority ? { ...reconciliationAuthority,
        expectedRevision: input.expectedRevision, intent: input.intent, affectedReferences } : undefined;
      if (input.strategy === "destructive-rebuild" && !destructiveApproval) {
        throw new Error("Destructive rebuilding is blocked until a persisted user message explicitly requests or approves replacement.");
      }
      const result = await deps.execute({ ...input, actionId: toolCallId, expectedEvidenceId: inspection.inspectionId,
        ...(destructiveApproval ? { destructiveApproval } : {}), ...(reconciliationResolution ? { reconciliationResolution } : {}),
        model: deps.model, skills: deps.skillAttribution() } as FusionActionRequestDto, signal);
      const rolledBack = result.status === "rolled-back";
      // Surface the attempted state's checks from result.checks, NOT from
      // inspection.current: after a rollback the current inspection is the
      // restored clean state recorded with no checks, which previously left the
      // model with only "failed immediate verification and was undone" - it
      // could never learn what was measured, so it re-guessed blindly and gave
      // up as "blocked by Fusion".
      const failedChecks = (result.checks ?? [])
        .filter((check) => check.status === "failed")
        .map((check) => `${check.kind} (${check.detail})`);
      const rollbackCheckText = failedChecks.length
        ? ` Failed checks: ${failedChecks.join("; ")}. Re-author this one feature so the document stays structurally sound - then retry; do not abandon the build.`
        : "";
      // Always hand back the independently measured geometry so the agent reads
      // real values instead of inferring them; declared-effect mismatches are
      // informational and the geometry is retained.
      const bodies = result.inspection?.current?.snapshot?.bodies ?? [];
      const measuredText = rolledBack || bodies.length === 0 ? "" : ` Measured geometry: ${bodies
        .map((body) => `${body.name} bounding box [${body.boundingBoxMm.map((value) => Math.round(value * 1000) / 1000).join(", ")}] mm, volume ${Math.round(body.volumeMm3 * 1000) / 1000} mm³`)
        .join("; ")}.`;
      const informationalText = !rolledBack && failedChecks.length
        ? ` Declared-effect mismatches (informational, geometry retained): ${failedChecks.join("; ")}. Read the measured values above - if the geometry is actually wrong, repair that one feature; if only your expectation was wrong, correct it and continue.`
        : "";
      const visualPersistenceUnavailable = result.status === "completed" && !result.visualArtifact;
      let sheet: Awaited<ReturnType<typeof inspectionSheetImage>>;
      let sheetFailure: string | undefined;
      try {
        sheet = await inspectionSheetImage(result);
      } catch (error) {
        sheetFailure = error instanceof Error ? error.message : String(error);
      }
      const sheetText = sheet
        ? ` Inspection sheet cells, left-to-right and top-to-bottom: ${sheet.views.join(", ")}.`
        : visualPersistenceUnavailable
          ? " The Fusion mutation completed, but revision-bound visual persistence is unavailable; recapture current evidence read-only with inspect_fusion including a visual-evidence check."
          : sheetFailure
          ? ` The Fusion mutation completed, but inspection-sheet rendering failed (${sheetFailure}); recapture current evidence read-only with inspect_fusion including a visual-evidence check.`
          : "";
      return {
        content: [{ type: "text", text: rolledBack
          ? `Fusion action broke the document structurally and was undone. Authoritative revision restored to ${result.finalRevision}.${rollbackCheckText}`
          : `Fusion action completed at revision ${result.finalRevision}; exactly one native Undo entry was created.${measuredText}${informationalText}${sheetText}` }, ...(sheet ? [sheet.image] : [])],
        details: { mutated: !rolledBack, status: result.status, precedingRevision: result.precedingRevision,
          finalRevision: result.finalRevision, undoEntries: result.undoEntries, ledgerRecordIds: result.ledgerRecordIds,
          inspection: result.inspection,
          ...(sheet && result.visualArtifact ? { visualArtifact: { ...result.visualArtifact,
            revision: result.finalRevision, inspectionSheet: {} } } : {}) },
      };
    },
  };
}
