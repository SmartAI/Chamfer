import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { isCadCodeIdentity, isMeasurements, type Gate, type Measurements } from "@chamfer/shared";

export const INSPECTION_SHEET_STUB_TEXT =
  "[Inspection sheet pixels evicted. The linked CAD code, measurements, verification verdict, and attachment remain available as historical evidence.]";

export interface CadCodeVersion {
  toolCallId: string;
  artifactId?: string;
  artifactVersion?: number;
}

export interface InspectionSheetEvidence {
  attachmentId: string;
  code: CadCodeVersion;
  measurements: Measurements;
  gate?: Gate;
}

interface SheetDetails {
  code?: CadCodeVersion;
  measurements?: Measurements;
  gate?: Gate;
  inspectionSheet?: InspectionSheetEvidence;
}

interface ContentBlock {
  type?: string;
  text?: string;
  kind?: string;
  attachmentId?: string;
}

function contentOf(message: unknown): ContentBlock[] | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const content = (message as { content?: unknown }).content;
  return Array.isArray(content) ? content : undefined;
}

/** A CAD execution or rendered visual read that produced the complete render
 * evidence needed for durable storage. inspect_fusion qualifies through its
 * revision-bound visualArtifact: a read-only visual read is exactly as
 * authoritative as an action render for evidence purposes. */
export function isRenderedCadResult(message: unknown): boolean {
  if (typeof message !== "object" || message === null) return false;
  const candidate = message as { role?: unknown; toolName?: unknown; isError?: unknown; details?: SheetDetails };
  if (candidate.role !== "toolResult" || !["run_build123d", "run_fusion_action", "inspect_fusion"].includes(String(candidate.toolName))) {
    return false;
  }
  const details = candidate.details as (SheetDetails & { visualArtifact?: unknown }) | undefined;
  const hasBuild123dEvidence = isCadCodeIdentity(details?.code) && isMeasurements(details?.measurements);
  const hasFusionEvidence = Boolean(details?.visualArtifact);
  return Boolean(
    (hasBuild123dEvidence || hasFusionEvidence) &&
    contentOf(message)?.some(
      (block) => block.type === "image" || (block.type === "attachment-reference" && block.kind === "view-sheet"),
    ),
  );
}

/** A rendered CAD result eligible to become the current reasoning and proof sheet. */
export function isInspectionSheetResult(message: unknown): boolean {
  if (!isRenderedCadResult(message)) return false;
  return (message as { isError?: unknown }).isError !== true;
}

function withoutPixels(message: AgentMessage): AgentMessage {
  const content = contentOf(message);
  if (!content) return message;
  return {
    ...(message as object),
    content: content.map((block) =>
      block.type === "image" || (block.type === "attachment-reference" && block.kind === "view-sheet")
        ? { type: "text", text: INSPECTION_SHEET_STUB_TEXT }
        : block,
    ),
  } as AgentMessage;
}

function isTerminalAssistant(message: unknown): boolean {
  if (typeof message !== "object" || message === null) return false;
  const candidate = message as { role?: unknown; content?: unknown; errorMessage?: unknown; stopReason?: unknown };
  if (candidate.role !== "assistant" || candidate.errorMessage || !Array.isArray(candidate.content)) return false;
  return (
    candidate.stopReason !== "toolUse" &&
    !candidate.content.some((block) => (block as { type?: unknown })?.type === "toolCall")
  );
}

function isInternalContinuation(message: unknown): boolean {
  if (typeof message !== "object" || message === null) return false;
  const candidate = message as { role?: unknown };
  if (candidate.role !== "user") return false;
  return Boolean(
    contentOf(message)?.some(
      (block) => block.type === "text" && /^\[Chamfer (?:self-check|plan check|visual check)\]/.test(block.text ?? ""),
    ),
  );
}

interface CurrentSheetState {
  index: number;
  active: boolean;
}

function currentSheetState(messages: AgentMessage[]): CurrentSheetState | undefined {
  let index = -1;
  messages.forEach((message, candidateIndex) => {
    if (isInspectionSheetResult(message)) index = candidateIndex;
  });
  if (index < 0) return undefined;

  let terminalIndex = -1;
  for (let candidateIndex = index + 1; candidateIndex < messages.length; candidateIndex += 1) {
    if (isTerminalAssistant(messages[candidateIndex])) terminalIndex = candidateIndex;
  }
  return {
    index,
    active: terminalIndex < 0 || messages.slice(terminalIndex + 1).some(isInternalContinuation),
  };
}

/** The exact durable current sheet while its reasoning lifecycle remains active. */
export function currentInspectionSheet(messages: AgentMessage[]): AgentMessage | undefined {
  const state = currentSheetState(messages);
  return state?.active ? messages[state.index] : undefined;
}

/**
 * Project the durable transcript to at most one pixel-bearing sheet.
 * A successful newer render replaces the current sheet, while failed runs are inert.
 */
export function projectCurrentInspectionSheet(messages: AgentMessage[]): AgentMessage[] {
  const state = currentSheetState(messages);
  if (!state) return messages;
  const sheetIndexes = messages.flatMap((message, index) => (isInspectionSheetResult(message) ? [index] : []));
  const indexesToEvict = sheetIndexes.filter((index) => index !== state.index || !state.active);
  if (indexesToEvict.length === 0) return messages;
  const evicted = new Set(indexesToEvict);
  return messages.map((message, index) => (evicted.has(index) ? withoutPixels(message) : message));
}

/** A read-only inspect_fusion result carrying a rendered view sheet (visual-evidence read). */
function isFusionInspectViewResult(message: unknown): boolean {
  if (typeof message !== "object" || message === null) return false;
  const candidate = message as { role?: unknown; toolName?: unknown; isError?: unknown; details?: { viewSheet?: unknown } };
  if (candidate.role !== "toolResult" || candidate.toolName !== "inspect_fusion" || candidate.isError === true) return false;
  return candidate.details?.viewSheet === true && Boolean(contentOf(message)?.some(
    (block) => block.type === "image" || (block.type === "attachment-reference" && block.kind === "view-sheet"),
  ));
}

/** Load-bearing prose contract with the inspect_fusion tool: the stubbing below
 * only recognizes inspection texts that start with this header and carry this
 * checks-line prefix, so both sides must share the exact strings. */
export const FUSION_INSPECTION_HEADER = "# Bound Fusion inspection";
export const FUSION_INSPECTION_CHECKS_PREFIX = "Checks: ";

function isSuccessfulFusionInspection(message: unknown): boolean {
  if (typeof message !== "object" || message === null) return false;
  const candidate = message as { role?: unknown; toolName?: unknown; isError?: unknown };
  return candidate.role === "toolResult" && candidate.toolName === "inspect_fusion" && candidate.isError !== true;
}

/**
 * Compact rendering of a superseded inspection text: identity lines stay, the
 * snapshot dump goes, and check verdicts collapse to counts plus the failed
 * details (the historically meaningful part). A full snapshot of a complex part
 * runs ~70k characters, and every inspection used to stay in model context
 * verbatim for the rest of the conversation - the dominant context-overflow
 * driver in long autonomous Fusion builds.
 */
export function stubStaleFusionInspectionText(text: string): string {
  if (!text.startsWith(FUSION_INSPECTION_HEADER)) return text;
  const lines = text.split("\n");
  const identity = lines.filter((line) => line.startsWith("Document: ") || line.startsWith("Revision: "));
  const checksLine = lines.find((line) => line.startsWith(FUSION_INSPECTION_CHECKS_PREFIX));
  let checksSummary = "";
  if (checksLine) {
    try {
      const checks = JSON.parse(checksLine.slice(FUSION_INSPECTION_CHECKS_PREFIX.length)) as { kind?: string; status?: string; detail?: string }[];
      const failed = checks.filter((check) => check.status === "failed");
      const passed = checks.filter((check) => check.status === "passed").length;
      checksSummary = ` ${passed} checks passed, ${failed.length} failed${
        failed.length > 0 ? `: ${failed.map((check) => `${check.kind} (${check.detail})`).join("; ")}` : "."
      }`;
    } catch {
      // Unparseable checks stay elided; the newest inspection carries the live verdicts.
    }
  }
  return [
    FUSION_INSPECTION_HEADER,
    ...identity,
    `[Superseded by a newer trusted inspection: snapshot elided.${checksSummary}]`,
  ].join("\n");
}

/** Newest matching message survives untouched; every earlier match is degraded.
 * Pure and deterministic over the message array (same contract as the pixel
 * eviction projections); indices are preserved and the durable transcript is
 * never rewritten. */
function projectAllButNewest(
  messages: AgentMessage[],
  matches: (message: unknown) => boolean,
  degrade: (message: AgentMessage) => AgentMessage,
): AgentMessage[] {
  const indexes = messages.flatMap((message, index) => (matches(message) ? [index] : []));
  if (indexes.length <= 1) return messages;
  const stale = new Set(indexes.slice(0, -1));
  return messages.map((message, index) => (stale.has(index) ? degrade(message) : message));
}

/**
 * Keep only the newest successful inspect_fusion result's full snapshot text in
 * model context; earlier inspections become compact identity + verdict stubs.
 */
export function projectStaleFusionInspectionText(messages: AgentMessage[]): AgentMessage[] {
  return projectAllButNewest(messages, isSuccessfulFusionInspection, (message) => {
    const content = contentOf(message);
    if (!content) return message;
    return {
      ...(message as object),
      content: content.map((block) =>
        block.type === "text" && typeof block.text === "string"
          ? { ...block, text: stubStaleFusionInspectionText(block.text) }
          : block,
      ),
    } as AgentMessage;
  });
}

/**
 * Keep only the newest inspect_fusion view sheet pixel-bearing; older visual reads
 * become text stubs. A routine scalar inspection carries no pixels, so this only ever
 * trims the handful of explicit visual-evidence reads, bounding image budget across a
 * long autonomous build the same way the CAD sheet lifecycle bounds action renders.
 */
export function projectCurrentFusionInspectViews(messages: AgentMessage[]): AgentMessage[] {
  return projectAllButNewest(messages, isFusionInspectViewResult, withoutPixels);
}

/** Add the logical attachment id to the render evidence already carried by a CAD result. */
export function withInspectionSheetEvidence(message: AgentMessage, attachmentId: string): AgentMessage {
  if (typeof message !== "object" || message === null || !isRenderedCadResult(message)) return message;
  const details = (message as unknown as { details?: SheetDetails }).details;
  const fusion = details as SheetDetails & { visualArtifact?: { inspectionSheet?: { attachmentId?: string } } };
  if (fusion.visualArtifact) {
    return { ...(message as object), details: { ...details, visualArtifact: { ...fusion.visualArtifact,
      inspectionSheet: { ...fusion.visualArtifact.inspectionSheet, attachmentId } } } } as AgentMessage;
  }
  if (!isCadCodeIdentity(details?.code) || !isMeasurements(details?.measurements)) return message;
  return {
    ...(message as object),
    details: {
      ...details,
      inspectionSheet: {
        attachmentId,
        code: details.code,
        measurements: details.measurements,
        ...(details.gate ? { gate: details.gate } : {}),
      },
    },
  } as AgentMessage;
}
